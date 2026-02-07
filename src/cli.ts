import { parseArgs } from './cli/args.ts'
import { formatHelp } from './cli/help.ts'
import { createCliUi, formatBytes, formatDurationMs, formatNumber } from './cli/ui.ts'
import {
  readNumberFlagWithDefault,
  readStringFlagWithDefault,
  resolveArangoConnectionConfig,
} from './config.ts'
import { bootstrapArango } from './domain/bootstrap.ts'
import { downloadGeofabrikExtract, resolveGeofabrikUrl } from './domain/download.ts'
import { importOsm } from './domain/import.ts'

export async function runCli(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const ui = createCliUi(process.stderr)
  const { positionals, flags } = parseArgs(argv)

  const wantsHelp
    = flags.help === true
      || positionals.length === 0
      || positionals[0] === 'help'
      || positionals[0] === '--help'

  if (wantsHelp) {
    ui.banner()
    process.stdout.write(`${formatHelp()}\n`)
    return
  }

  const command = positionals[0]
  if (command !== 'geofabrik-url')
    ui.banner()

  try {
    if (command === 'bootstrap') {
      const conn = resolveArangoConnectionConfig(env, flags)
      const collection = readStringFlagWithDefault(flags, 'collection', 'osm_features')
      const startedAt = Date.now()
      ui.info(`Bootstrapping ArangoDB: db=${conn.database} collection=${collection}`)
      await bootstrapArango(conn, { collection })
      process.stdout.write(`Bootstrapped ArangoDB: db=${conn.database} collection=${collection}\n`)
      process.stdout.write(`Duration: ${formatDurationMs(Date.now() - startedAt)}\n`)
      return
    }

    if (command === 'download') {
      const regionOrUrl = positionals[1]
      if (!regionOrUrl)
        throw new Error('Missing argument: <region|url>')

      const outDir = readStringFlagWithDefault(flags, 'out-dir', 'data')
      const baseUrl = readStringFlagWithDefault(flags, 'base-url', 'https://download.geofabrik.de')

      const url = resolveGeofabrikUrl(regionOrUrl, baseUrl)
      ui.info(`Downloading ${url}`)

      const startedAt = Date.now()
      let lastAt = startedAt
      let lastBytes = 0

      const result = await downloadGeofabrikExtract(regionOrUrl, { outDir, baseUrl }, {
        onProgress: ({ downloadedBytes, totalBytes }) => {
          const now = Date.now()
          const dtMs = now - lastAt
          const dBytes = downloadedBytes - lastBytes
          const speedBps = dtMs > 0 ? (dBytes * 1000) / dtMs : 0

          lastAt = now
          lastBytes = downloadedBytes

          const total = totalBytes ? ` / ${formatBytes(totalBytes)}` : ''
          const pct = totalBytes ? Math.min(100, (downloadedBytes / totalBytes) * 100) : undefined
          const pctStr = pct !== undefined ? ` (${pct.toFixed(0)}%)` : ''
          const speed = speedBps > 0 ? ` @ ${formatBytes(speedBps)}/s` : ''
          ui.progress(`Downloading ${formatBytes(downloadedBytes)}${total}${pctStr}${speed}`)
        },
      })
      ui.progressDone()
      process.stdout.write(`Downloaded ${result.url}\nSaved to ${result.path}\n`)
      process.stdout.write(`Duration: ${formatDurationMs(Date.now() - startedAt)}\n`)
      return
    }

    if (command === 'import') {
      const input = positionals[1]
      if (!input)
        throw new Error('Missing argument: <file>')

      const conn = resolveArangoConnectionConfig(env, flags)
      const collection = readStringFlagWithDefault(flags, 'collection', 'osm_features')

      const adapterFlag = flags.adapter
      const adapter
        = typeof adapterFlag === 'string'
          ? adapterFlag
          : input.endsWith('.ndjson')
            ? 'ndjson'
            : 'osmium-geojsonseq'

      if (adapter !== 'ndjson' && adapter !== 'osmium-geojsonseq') {
        throw new Error(`Invalid --adapter: ${String(adapterFlag)}`)
      }

      const chunkMb = readNumberFlagWithDefault(flags, 'chunk-mb', 8)
      const concurrency = readNumberFlagWithDefault(flags, 'concurrency', 2)
      const onDuplicate = readStringFlagWithDefault(flags, 'on-duplicate', 'update')
      if (!['error', 'update', 'replace', 'ignore'].includes(onDuplicate)) {
        throw new Error(`Invalid --on-duplicate: ${onDuplicate}`)
      }

      const unsupportedGeometry = readStringFlagWithDefault(flags, 'unsupported-geometry', 'skip')
      if (!['skip', 'keep', 'error'].includes(unsupportedGeometry)) {
        throw new Error(`Invalid --unsupported-geometry: ${unsupportedGeometry}`)
      }

      ui.info(
        `Importing ${input} into ${conn.database}.${collection} `
        + `(adapter=${adapter} chunkMb=${chunkMb} concurrency=${concurrency} onDuplicate=${onDuplicate} unsupportedGeometry=${unsupportedGeometry})`,
      )
      const startedAt = Date.now()

      const summary = await importOsm(conn, input, {
        collection,
        adapter,
        chunkBytes: chunkMb * 1024 * 1024,
        concurrency,
        onDuplicate: onDuplicate as 'error' | 'update' | 'replace' | 'ignore',
        unsupportedGeometry: unsupportedGeometry as 'skip' | 'keep' | 'error',
      }, {
        onProgress: (p) => {
          const elapsedMs = Date.now() - startedAt
          const elapsedSec = elapsedMs > 0 ? elapsedMs / 1000 : 0
          const rate = elapsedSec > 0 ? p.seen / elapsedSec : 0
          const rateStr = rate > 0 ? `${formatNumber(Math.round(rate))}/s` : '0/s'

          ui.progress(
            `Import ${p.phase}: `
            + `seen=${formatNumber(p.seen)} `
            + `created=${formatNumber(p.created)} `
            + `updated=${formatNumber(p.updated)} `
            + `skipped=${formatNumber(p.skippedUnsupportedGeometry)} `
            + `errors=${formatNumber(p.errors)} `
            + `inFlight=${formatNumber(p.inFlight)} `
            + `rate=${rateStr}`,
          )
        },
      })
      ui.progressDone()

      process.stdout.write(`Imported into ${conn.database}.${collection}\n`)
      process.stdout.write(`Seen: ${summary.seen}\n`)
      process.stdout.write(`Created: ${summary.created} Updated: ${summary.updated} Ignored: ${summary.ignored} Empty: ${summary.empty} Errors: ${summary.errors}\n`)

      if (summary.skippedUnsupportedGeometry > 0) {
        process.stdout.write(
          `Skipped unsupported geometry: ${summary.skippedUnsupportedGeometry} (mode: ${summary.unsupportedGeometryMode})\n`,
        )
      }
      else {
        process.stdout.write(`Unsupported geometry: 0 (mode: ${summary.unsupportedGeometryMode})\n`)
      }

      process.stdout.write(formatGeometryCounts('Geometry types', summary.geometryTypeCounts))

      if (Object.keys(summary.unsupportedGeometryTypeCounts).length > 0) {
        process.stdout.write(formatGeometryCounts('Unsupported geometry types', summary.unsupportedGeometryTypeCounts))
      }

      process.stdout.write(`Duration: ${formatDurationMs(Date.now() - startedAt)}\n`)
      return
    }

    if (command === 'geofabrik-url') {
      // Small helper for scripts.
      const regionOrUrl = positionals[1]
      if (!regionOrUrl)
        throw new Error('Missing argument: <region|url>')
      const baseUrl = readStringFlagWithDefault(flags, 'base-url', 'https://download.geofabrik.de')
      process.stdout.write(`${resolveGeofabrikUrl(regionOrUrl, baseUrl)}\n`)
      return
    }

    throw new Error(`Unknown command: ${command}`)
  }
  catch (err) {
    ui.progressDone()
    const msg = err instanceof Error ? err.message : String(err)
    ui.error(msg)
    process.stderr.write(`\n${formatHelp()}\n`)
    process.exitCode = 1
  }
}

function formatGeometryCounts(title: string, counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0)
    return `${title}: (none)\n`

  const lines: string[] = []
  lines.push(`${title}:`)
  for (const [k, v] of entries) {
    lines.push(`  ${k}: ${v}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
