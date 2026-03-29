export type ProbeKind = 'powershell' | 'bash' | 'python';
export type ProbeShell = 'powershell' | 'cmd' | 'wsl-bash' | 'bash';

export type CorpusProfile = {
  version: number;
  mode: 'quick' | 'better';
  recursive: boolean;
  filesSampled: number;
  avgSizeMb: number;
  p95SizeMb: number;
  maxSizeMb: number;
  avgPages?: number | null;
  p95Pages?: number | null;
  maxPages?: number | null;
  filesWithPageCount?: number | null;
  failedPageReads?: number | null;
};

export function buildProbeScript(kind: ProbeKind, recursive: boolean, targetPath: string, shell: ProbeShell = 'bash'): string {
  if (kind === 'powershell') return buildPowerShellProbe(recursive, targetPath);
  if (kind === 'bash') return buildBashProbe(recursive, targetPath);
  return buildPythonProbe(recursive, targetPath, shell);
}

function buildPowerShellProbe(recursive: boolean, targetPath: string): string {
  const recurse = recursive ? '-Recurse' : '';
  const root = targetPath ? `$root = '${targetPath.replace(/'/g, "''")}'` : '$root = (Get-Location).Path';
  return [
    root,
    "$files = Get-ChildItem -Path $root -File -Filter '*.pdf' " + recurse,
    "if (-not $files) { Write-Output '{\"version\":1,\"mode\":\"quick\",\"recursive\":" + (recursive ? 'true' : 'false') + ",\"filesSampled\":0}'; exit }",
    '$sizes = $files | ForEach-Object { [math]::Round($_.Length / 1MB, 3) } | Sort-Object',
    '$count = $sizes.Count',
    '$avg = [math]::Round((($sizes | Measure-Object -Average).Average), 3)',
    '$p95Index = [math]::Min([math]::Ceiling($count * 0.95) - 1, $count - 1)',
    '$p95 = [math]::Round($sizes[$p95Index], 3)',
    '$max = [math]::Round($sizes[$count - 1], 3)',
    '$obj = [ordered]@{',
    '  version = 1',
    "  mode = 'quick'",
    '  recursive = ' + (recursive ? '$true' : '$false'),
    '  filesSampled = $count',
    '  avgSizeMb = $avg',
    '  p95SizeMb = $p95',
    '  maxSizeMb = $max',
    '}',
    '$obj | ConvertTo-Json -Compress',
  ].join('\n') + '\n';
}

function buildBashProbe(recursive: boolean, targetPath: string): string {
  const root = targetPath || '.';
  const findExpr = recursive
    ? `find "${root.replace(/"/g, '\\"')}" -type f \\( -iname '*.pdf' \\) -print0`
    : `find "${root.replace(/"/g, '\\"')}" -maxdepth 1 -type f \\( -iname '*.pdf' \\) -print0`;
  return [
    'tmp=$(mktemp)',
    `while IFS= read -r -d '' f; do wc -c < "$f"; done < <(${findExpr}) | sort -n > "$tmp"`,
    'count=$(wc -l < "$tmp" | tr -d " ")',
    `if [ "$count" -eq 0 ]; then echo '{"version":1,"mode":"quick","recursive":${recursive ? 'true' : 'false'},"filesSampled":0}'; rm -f "$tmp"; exit 0; fi`,
    'avgBytes=$(awk \'{s+=$1} END {printf "%.3f", s/NR}\' "$tmp")',
    'p95Line=$(( (95 * count + 99) / 100 ))',
    'p95Bytes=$(sed -n "${p95Line}p" "$tmp")',
    'maxBytes=$(tail -n 1 "$tmp")',
    'avgMb=$(awk -v n="$avgBytes" \'BEGIN {printf "%.3f", n/1024/1024}\')',
    'p95Mb=$(awk -v n="$p95Bytes" \'BEGIN {printf "%.3f", n/1024/1024}\')',
    'maxMb=$(awk -v n="$maxBytes" \'BEGIN {printf "%.3f", n/1024/1024}\')',
    `printf '{"version":1,"mode":"quick","recursive":${recursive ? 'true' : 'false'},"filesSampled":%s,"avgSizeMb":%s,"p95SizeMb":%s,"maxSizeMb":%s}\n' "$count" "$avgMb" "$p95Mb" "$maxMb"`,
    'rm -f "$tmp"',
  ].join('\n') + '\n';
}

function buildPythonProbe(recursive: boolean, targetPath: string, shell: ProbeShell): string {
  const body = [
    'import json, math, logging, sys, warnings',
    'from pathlib import Path',
    'from pypdf import PdfReader',
    'warnings.filterwarnings("ignore")',
    'logging.getLogger("pypdf").setLevel(logging.ERROR)',
    '',
    `recursive = ${recursive ? 'True' : 'False'}`,
    `root = Path(r'''${(targetPath || '.').replace(/'/g, "''")}''').resolve()`,
    "files = sorted(root.rglob('*.pdf') if recursive else root.glob('*.pdf'))",
    'print(f"[grobid probe] scanning {len(files)} PDFs from {root}", file=sys.stderr)',
    'if not files:',
    "    print(json.dumps({'version': 1, 'mode': 'better', 'recursive': recursive, 'filesSampled': 0}))",
    '    raise SystemExit(0)',
    'sizes = []',
    'pages = []',
    'failed = 0',
    'for path in files:',
    '    sizes.append(round(path.stat().st_size / (1024 * 1024), 3))',
    'sizes.sort()',
    'for idx, path in enumerate(files, 1):',
    '    try:',
    '        pages.append(len(PdfReader(str(path)).pages))',
    '    except Exception:',
    '        failed += 1',
    '    if idx % 250 == 0:',
    '        print(f"[grobid probe] page counts: {idx}/{len(files)}", file=sys.stderr)',
    'pages.sort()',
    'count = len(sizes)',
    'size_p95 = sizes[min(math.ceil(count * 0.95) - 1, count - 1)]',
    'out = {',
    "    'version': 1,",
    "    'mode': 'better',",
    "    'recursive': recursive,",
    "    'filesSampled': count,",
    "    'avgSizeMb': round(sum(sizes) / count, 3),",
    "    'p95SizeMb': round(size_p95, 3),",
    "    'maxSizeMb': round(sizes[-1], 3),",
    '}',
    'if pages:',
    '    page_count = len(pages)',
    '    page_p95 = pages[min(math.ceil(page_count * 0.95) - 1, page_count - 1)]',
    "    out['filesWithPageCount'] = page_count",
    "    out['failedPageReads'] = failed",
    "    out['avgPages'] = round(sum(pages) / page_count, 2)",
    "    out['p95Pages'] = page_p95",
    "    out['maxPages'] = pages[-1]",
    'else:',
    "    out['filesWithPageCount'] = 0",
    "    out['failedPageReads'] = failed",
    "    out['avgPages'] = None",
    "    out['p95Pages'] = None",
    "    out['maxPages'] = None",
    'print(json.dumps(out, separators=(",", ":")))',
  ].join('\n');

  if (shell === 'powershell') {
    return [
      'python -m pip install --quiet pypdf',
      "$code = @'",
      body,
      "'@",
      '$code | python -u -',
    ].join('\n') + '\n';
  }

  if (shell === 'cmd') {
    const echoBody = body.split('\n').map((line) => `echo ${line}`).join('\n');
    return [
      'python -m pip install --quiet pypdf',
      '(',
      echoBody,
      ') | python -u -',
    ].join('\n') + '\n';
  }

  return [
    'python -m pip install --quiet pypdf',
    "python -u - <<'PY'",
    body,
    'PY',
  ].join('\n') + '\n';
}

export function parseCorpusProfile(raw: string): CorpusProfile | null {
  try {
    const parsed = JSON.parse(raw) as CorpusProfile;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.filesSampled !== 'number') return null;
    if (typeof parsed.avgSizeMb !== 'number' && parsed.filesSampled > 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function estimateRecommendedMemory(profile: CorpusProfile, image: 'standard' | 'full', concurrency: number): { recommended: number; min: number; max: number; rationale: string } | null {
  if (!profile.filesSampled) return null;

  const base = image === 'full' ? 10 : 4;
  const sizeFactor = Math.max(0, Math.ceil((profile.p95SizeMb || 0) / 8));
  const pageFactor = profile.p95Pages ? Math.max(0, Math.ceil(profile.p95Pages / 40)) : 0;
  const concurrencyFactor = Math.max(0, Math.ceil(concurrency / (image === 'full' ? 2 : 3)) - 1);
  const safety = image === 'full' ? 2 : 1;

  const recommended = Math.max(image === 'full' ? 12 : 4, base + sizeFactor + pageFactor + concurrencyFactor + safety);
  const min = Math.max(image === 'full' ? 10 : 4, recommended - 2);
  const max = recommended + 4;
  const rationale = profile.p95Pages
    ? `Based on p95 file size ${profile.p95SizeMb} MB, p95 pages ${profile.p95Pages}, and concurrency ${concurrency}.`
    : `Based on p95 file size ${profile.p95SizeMb} MB and concurrency ${concurrency}.`;

  return { recommended, min, max, rationale };
}

export function estimateMemoryBreakdown(profile: CorpusProfile, image: 'standard' | 'full', concurrency: number): {
  base: number;
  sizeFactor: number;
  pageFactor: number;
  concurrencyFactor: number;
  safety: number;
  floor: number;
  raw: number;
  recommended: number;
} | null {
  if (!profile.filesSampled) return null;
  const base = image === 'full' ? 10 : 4;
  const sizeFactor = Math.max(0, Math.ceil((profile.p95SizeMb || 0) / 8));
  const pageFactor = profile.p95Pages ? Math.max(0, Math.ceil(profile.p95Pages / 40)) : 0;
  const concurrencyFactor = Math.max(0, Math.ceil(concurrency / (image === 'full' ? 2 : 3)) - 1);
  const safety = image === 'full' ? 2 : 1;
  const floor = image === 'full' ? 12 : 4;
  const raw = base + sizeFactor + pageFactor + concurrencyFactor + safety;
  const recommended = Math.max(floor, raw);
  return { base, sizeFactor, pageFactor, concurrencyFactor, safety, floor, raw, recommended };
}
