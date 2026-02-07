export interface WritableTextStream {
  write: (chunk: string) => unknown
  isTTY?: boolean
  columns?: number
}

export interface CliUi {
  banner: () => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  progress: (message: string) => void
  progressDone: (finalMessage?: string) => void
  readonly isTTY: boolean
}

export function createCliUi(stream: WritableTextStream = process.stderr): CliUi {
  const isTTY = stream.isTTY === true
  const columns = typeof stream.columns === 'number' ? stream.columns : undefined

  let progressActive = false
  let lastProgressLen = 0
  let bannerPrinted = false
  let spinnerIdx = 0

  type LogKind = 'INFO' | 'WARN' | 'ERROR' | 'PROG' | 'DONE'

  const formatLine = (kind: LogKind, message: string): string => {
    const tag = kind.padEnd(5, ' ')
    return `${tag} | ${message}`
  }

  const nextSpinner = (): string => {
    // ASCII-only spinner. Keep stable and predictable.
    const frames = ['-', '\\', '|', '/'] as const
    const frame = frames[spinnerIdx % frames.length] ?? '-'
    spinnerIdx++
    return frame
  }

  function progressDone(finalMessage?: string): void {
    if (!progressActive)
      return

    if (!isTTY) {
      progressActive = false
      lastProgressLen = 0
      return
    }

    const line = finalMessage ? formatLine('DONE', finalMessage) : ''
    const truncated = columns ? truncateToColumns(line, columns) : line
    const padding = lastProgressLen > truncated.length ? ' '.repeat(lastProgressLen - truncated.length) : ''
    stream.write(`\r${truncated}${padding}\n`)
    progressActive = false
    lastProgressLen = 0
  }

  function writeLine(line: string): void {
    if (progressActive)
      progressDone()
    stream.write(`${line}\n`)
  }

  function banner(): void {
    if (!isTTY || bannerPrinted)
      return
    bannerPrinted = true

    const lines = [
      'osm2arango',
      'OSM extracts -> ArangoDB (Bun + TypeScript)',
    ]

    // Keep the UI usable in narrow terminals.
    if (columns !== undefined && columns < 60) {
      writeLine(lines[0] ?? 'osm2arango')
      writeLine(lines[1] ?? '')
      writeLine('')
      return
    }

    const width = Math.max(...lines.map(l => l.length))
    const top = `+${'-'.repeat(width + 2)}+`
    writeLine(top)
    for (const line of lines) {
      writeLine(`| ${line.padEnd(width, ' ')} |`)
    }
    writeLine(top)
    writeLine('')
  }

  function info(message: string): void {
    writeLine(formatLine('INFO', message))
  }

  function warn(message: string): void {
    writeLine(formatLine('WARN', message))
  }

  function error(message: string): void {
    writeLine(formatLine('ERROR', message))
  }

  function progress(message: string): void {
    if (!isTTY) {
      stream.write(`${formatLine('PROG', message)}\n`)
      return
    }

    progressActive = true
    const msg = `${nextSpinner()} ${message}`
    const line0 = formatLine('PROG', msg)
    const line = columns ? truncateToColumns(line0, columns) : line0
    const padding = lastProgressLen > line.length ? ' '.repeat(lastProgressLen - line.length) : ''
    lastProgressLen = line.length
    stream.write(`\r${line}${padding}`)
  }

  return { banner, info, warn, error, progress, progressDone, isTTY }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0)
    return '0 B'
  if (bytes < 1024)
    return `${Math.floor(bytes)} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 0; i < units.length; i++) {
    unit = units[i] ?? 'KB'
    if (value < 1024)
      break
    value /= 1024
  }

  const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return `${formatted} ${unit}`
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n))
    return '0'
  return new Intl.NumberFormat('en-US').format(n)
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0)
    return '0s'

  if (ms < 1000)
    return `${Math.round(ms)}ms`

  if (ms < 10_000)
    return `${(ms / 1000).toFixed(1)}s`

  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60)
    return `${totalSeconds}s`

  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`
  }

  const minutes = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) {
    return `${totalHours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
  }

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
}

function truncateToColumns(text: string, columns: number): string {
  // Keep one column for the cursor to avoid wrapping.
  const max = Math.max(0, columns - 1)
  if (text.length <= max)
    return text
  if (max <= 3)
    return text.slice(0, max)
  return `${text.slice(0, max - 3)}...`
}
