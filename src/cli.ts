import type { ImportProgress } from './domain/import.ts'

import { parseArgs } from './cli/args.ts'
import { formatHelp } from './cli/help.ts'
import { createCliUi, formatBytes, formatDurationMs, formatNumber } from './cli/ui.ts'
import { runWizard } from './cli/wizard.ts'
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
      const indexes = readStringFlagWithDefault(flags, 'indexes', 'all')
      if (!['all', 'none', 'geo', 'tags'].includes(indexes)) {
        throw new Error(`Invalid --indexes: ${indexes}`)
      }
      const startedAt = Date.now()
      ui.info(`Bootstrapping ArangoDB: db=${conn.database} collection=${collection} indexes=${indexes}`)
      await bootstrapArango(conn, { collection, indexes: indexes as 'all' | 'none' | 'geo' | 'tags' })
      process.stdout.write(`Bootstrapped ArangoDB: db=${conn.database} collection=${collection} indexes=${indexes}\n`)
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

      const maxLineMb = readNumberFlagWithDefault(flags, 'max-line-mb', 8)

      const importTransportFlag = flags['import-transport']
      if (importTransportFlag === true)
        throw new Error('Missing value for --import-transport')
      const importTransport
        = typeof importTransportFlag === 'string'
          ? importTransportFlag
          : Bun.which('curl')
            ? 'curl'
            : 'arangojs'
      if (!['arangojs', 'node-http', 'curl'].includes(importTransport)) {
        throw new Error(`Invalid --import-transport: ${importTransport}`)
      }

      const invalidJson = readStringFlagWithDefault(flags, 'invalid-json', 'error')
      if (!['error', 'skip'].includes(invalidJson)) {
        throw new Error(`Invalid --invalid-json: ${invalidJson}`)
      }

      const osmiumIndexTypeFlag = flags['osmium-index-type']
      const osmiumIndexType = typeof osmiumIndexTypeFlag === 'string' ? osmiumIndexTypeFlag : undefined

      const profile = readStringFlagWithDefault(flags, 'profile', 'places')
      if (!['all', 'places', 'amenities', 'recreation'].includes(profile)) {
        throw new Error(`Invalid --profile: ${profile}`)
      }

      const osmiumGeometryTypesFlag = flags['osmium-geometry-types']
      const osmiumGeometryTypesRaw = typeof osmiumGeometryTypesFlag === 'string' ? osmiumGeometryTypesFlag : undefined
      // Sensible default: drop LineStrings for place scoring use-cases.
      const osmiumGeometryTypes = osmiumGeometryTypesRaw ?? (profile === 'all' ? undefined : 'point,polygon')

      const dryRun = flags['dry-run'] === true
      const noProgress = flags['no-progress'] === true

      ui.info(
        `Importing ${input} into ${conn.database}.${collection} `
        + `(adapter=${adapter} profile=${profile} chunkMb=${chunkMb} maxLineMb=${maxLineMb} concurrency=${concurrency} onDuplicate=${onDuplicate} unsupportedGeometry=${unsupportedGeometry} importTransport=${importTransport} invalidJson=${invalidJson}${osmiumIndexType ? ` osmiumIndexType=${osmiumIndexType}` : ''}${osmiumGeometryTypes ? ` osmiumGeometryTypes=${osmiumGeometryTypes}` : ''}${dryRun ? ' dryRun=true' : ''})`,
      )
      const startedAt = Date.now()

      const importDeps: { onProgress?: (p: ImportProgress) => void } = {}
      if (!noProgress) {
        importDeps.onProgress = (p) => {
          const elapsedMs = Date.now() - startedAt
          const elapsedSec = elapsedMs > 0 ? elapsedMs / 1000 : 0
          const rate = elapsedSec > 0 ? p.seen / elapsedSec : 0
          const rateStr = rate > 0 ? `${formatNumber(Math.round(rate))}/s` : '0/s'

          ui.progress(
            `Import ${p.phase}: `
            + `profile=${p.profile} `
            + `seen=${formatNumber(p.seen)} `
            + `created=${formatNumber(p.created)} `
            + `updated=${formatNumber(p.updated)} `
            + `skippedGeom=${formatNumber(p.skippedUnsupportedGeometry)} `
            + `skippedProf=${formatNumber(p.skippedByProfile)} `
            + `skippedLong=${formatNumber(p.skippedTooLongLines)} `
            + `skippedJson=${formatNumber(p.skippedInvalidJsonLines)} `
            + `errors=${formatNumber(p.errors)} `
            + `inFlight=${formatNumber(p.inFlight)} `
            + `rate=${rateStr}`,
          )
        }
      }

      const summary = await importOsm(conn, input, {
        collection,
        adapter,
        chunkBytes: chunkMb * 1024 * 1024,
        maxLineBytes: maxLineMb * 1024 * 1024,
        concurrency,
        onDuplicate: onDuplicate as 'error' | 'update' | 'replace' | 'ignore',
        unsupportedGeometry: unsupportedGeometry as 'skip' | 'keep' | 'error',
        importTransport: importTransport as 'arangojs' | 'node-http' | 'curl',
        invalidJson: invalidJson as 'error' | 'skip',
        ...(osmiumIndexType ? { osmiumIndexType } : {}),
        ...(osmiumGeometryTypes ? { osmiumGeometryTypes } : {}),
        profile: profile as 'all' | 'places' | 'amenities' | 'recreation',
        dryRun,
      }, importDeps)
      ui.progressDone()

      process.stdout.write(`${dryRun ? 'Dry run completed' : 'Imported'} into ${conn.database}.${collection}\n`)
      process.stdout.write(`Profile: ${summary.profile}\n`)
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

      if (summary.skippedTooLongLines > 0) {
        const largest = summary.maxTooLongLineBytes > 0 ? `, largest=${formatBytes(summary.maxTooLongLineBytes)}` : ''
        process.stdout.write(`Skipped too-long lines: ${summary.skippedTooLongLines}${largest}\n`)
      }

      if (summary.skippedByProfile > 0) {
        process.stdout.write(`Skipped by profile: ${summary.skippedByProfile}\n`)
      }

      if (summary.skippedInvalidJsonLines > 0) {
        const largest = summary.maxInvalidJsonLineBytes > 0 ? `, largest~=${formatBytes(summary.maxInvalidJsonLineBytes)}` : ''
        process.stdout.write(`Skipped invalid JSON lines: ${summary.skippedInvalidJsonLines}${largest}\n`)
      }

      process.stdout.write(`Duration: ${formatDurationMs(Date.now() - startedAt)}\n`)
      return
    }

    if (command === 'wizard') {
      await runWizard(env, flags, ui)
      return
    }

    if (command === 'geofabrik-url') {
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
