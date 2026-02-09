import type { ArangoConnectionConfig } from '../config.ts'
import type { GeofabrikIndex, GeofabrikRegion } from '../domain/geofabrik-index.ts'
import type { ImportProfile } from '../osm/import-profile.ts'

import type { CliFlagValue } from './args.ts'
import type { CliUi } from './ui.ts'

import { rm } from 'node:fs/promises'

import { bootstrapArango } from '../domain/bootstrap.ts'
import { downloadGeofabrikExtract, resolveGeofabrikUrl } from '../domain/download.ts'
import { loadGeofabrikIndex } from '../domain/geofabrik-index.ts'
import { importOsm } from '../domain/import.ts'
import { PromptCancelledError, promptConfirm, promptNumber, promptPassword, promptSelect, promptText } from './prompts.ts'
import { detectOsmiumInstallPlan } from './requirements.ts'
import { formatBytes, formatDurationMs, formatNumber } from './ui.ts'

export async function runWizard(
  env: Record<string, string | undefined>,
  flags: Record<string, CliFlagValue>,
  ui: CliUi,
): Promise<void> {
  if (process.stdin.isTTY !== true || ui.isTTY !== true) {
    throw new Error('Wizard requires an interactive terminal (TTY).')
  }

  const io = { input: process.stdin, output: process.stderr }
  const autoYes = flags.yes === true
  const planOnly = flags.plan === true
  try {
    ui.info('Wizard mode: guided Geofabrik download + import')
    ui.info('Tip: set ARANGO_URL/ARANGO_DB/ARANGO_USER/ARANGO_PASS to avoid re-typing connection settings.')

    if (planOnly) {
      ui.warn('Wizard is running in plan mode (--plan): no downloads, no writes.')
    }

    // Requirements (only needed when actually importing).
    if (!planOnly) {
      await ensureOsmiumAvailable(io, ui, { autoYes })
    }
    else if (!Bun.which('osmium')) {
      ui.warn('osmium is not in PATH. Plan mode can continue, but a real import requires osmium (or use Docker importer).')
    }

    // Step 1: Connection
    ui.info('Step 1/7: Connection')
    const conn = await promptArangoConnection(io, env, flags, ui)

    // Step 2: Target collection
    ui.info('Step 2/7: Target collection')
    const collection = await promptText(io, 'ArangoDB collection', {
      defaultValue: readStringFlag(flags, 'collection') ?? 'osm_features',
      required: true,
    })

    // Step 3: Index strategy
    ui.info('Step 3/7: Index strategy')
    const indexesBefore = await promptSelect(io, 'Indexes before import (faster ingest = none)', [
      { label: 'none', value: 'none', hint: '(recommended for large imports)' },
      { label: 'geo', value: 'geo' },
      { label: 'tags', value: 'tags' },
      { label: 'all', value: 'all' },
    ], { initialValue: 'none', pageSize: 8, filterable: false })

    const indexesAfter = await promptSelect(io, 'Indexes after import', [
      { label: 'all (geo + tags)', value: 'all', hint: '(recommended)' },
      { label: 'geo only', value: 'geo' },
      { label: 'tags only', value: 'tags' },
      { label: 'none (create later)', value: 'none' },
    ], { initialValue: 'all', pageSize: 8, filterable: false })

    // Step 4: Geofabrik region selection
    ui.info('Step 4/7: Geofabrik region')
    ui.info('Fetching Geofabrik index...')
    const index = await loadGeofabrikIndex()
    const regionFlag = readStringFlag(flags, 'region')
    const regionId = regionFlag ? validateRegionFlag(regionFlag, index) : await pickGeofabrikRegion(io, index)
    const region = index.regionsById[regionId]
    if (!region) {
      throw new Error(`Selected region not found in index: ${regionId}`)
    }
    if (!region.pbfUrl) {
      throw new Error(`Selected region has no PBF URL: ${regionId}`)
    }

    const scopeFlag = readStringFlag(flags, 'scope')
    const scope = scopeFlag ? validateScopeFlag(scopeFlag) : await promptImportScope(io, index, regionId)
    const jobs = buildRegionJobs(index, regionId, scope)
    if (jobs.length === 0) {
      throw new Error('No downloadable regions found for the selected scope.')
    }

    // Step 5: Import profile + geometry volume
    ui.info('Step 5/7: Import profile')
    const profile = await promptSelect(io, 'Import profile', [
      { label: 'places (amenities + recreation)', value: 'places' },
      { label: 'amenities (amenity=*)', value: 'amenities' },
      { label: 'recreation (green/water/leisure)', value: 'recreation' },
      { label: 'all (everything)', value: 'all' },
    ], { initialValue: 'places', pageSize: 8, filterable: false }) as ImportProfile

    let osmiumGeometryTypes: string | undefined
    if (profile === 'all') {
      const geometryChoice = await promptSelect(io, 'Osmium geometry types', [
        { label: 'osmium default (full fidelity)', value: 'osmium-default' },
        { label: 'point,polygon (drop most roads)', value: 'point,polygon' },
        { label: 'point,linestring,polygon (explicit all)', value: 'point,linestring,polygon' },
      ], { initialValue: 'osmium-default', pageSize: 8, filterable: false })
      osmiumGeometryTypes = geometryChoice === 'osmium-default' ? undefined : geometryChoice
    }
    else {
      const includeRoads = autoYes
        ? false
        : await promptConfirm(io, 'Include roads/LineStrings? (usually not needed for place scoring)', { initialValue: false })
      osmiumGeometryTypes = includeRoads ? 'point,linestring,polygon' : 'point,polygon'
    }

    // Step 6: Performance knobs
    ui.info('Step 6/7: Import settings')
    const chunkMb = await promptNumber(io, 'Import chunk size (MB)', { defaultValue: 32, min: 1 })
    const concurrency = await promptNumber(io, 'Import concurrency (in-flight batches)', { defaultValue: 1, min: 1 })
    const maxLineMb = await promptNumber(io, 'Max input line size (MB)', { defaultValue: 8, min: 1 })

    const onDuplicate = await promptSelect(io, 'On duplicate _key', [
      { label: 'update (default)', value: 'update' },
      { label: 'ignore', value: 'ignore' },
      { label: 'replace', value: 'replace' },
      { label: 'error', value: 'error' },
    ], { initialValue: 'update', pageSize: 8, filterable: false }) as 'error' | 'ignore' | 'replace' | 'update'

    const unsupportedGeometry = await promptSelect(io, 'Unsupported geometry', [
      { label: 'skip (default)', value: 'skip' },
      { label: 'keep', value: 'keep' },
      { label: 'error', value: 'error' },
    ], { initialValue: 'skip', pageSize: 8, filterable: false }) as 'error' | 'keep' | 'skip'

    const invalidJson = await promptSelect(io, 'Invalid JSON lines', [
      { label: 'error (default)', value: 'error' },
      { label: 'skip', value: 'skip' },
    ], { initialValue: 'error', pageSize: 8, filterable: false }) as 'error' | 'skip'

    const curlAvailable = Boolean(Bun.which('curl'))
    const importTransport = await promptSelect(io, 'Import transport', [
      { label: 'curl (fast, stable)', value: 'curl', ...(curlAvailable ? {} : { disabled: true, hint: '(not in PATH)' }) },
      { label: 'arangojs (JS driver)', value: 'arangojs' },
      { label: 'node-http', value: 'node-http' },
    ], { initialValue: curlAvailable ? 'curl' : 'arangojs', pageSize: 8, filterable: false }) as 'arangojs' | 'curl' | 'node-http'

    const useFileIndex = autoYes
      ? true
      : await promptConfirm(io, 'Use safe osmium file-based node-location index? (recommended for large extracts)', { initialValue: true })
    const osmiumIndexBasePath = useFileIndex
      ? await promptText(io, 'Osmium index base path', { defaultValue: '/tmp/osmium.node.locations', required: true })
      : undefined

    // Step 7: Downloads
    ui.info('Step 7/7: Downloads')
    const outDir = await promptText(io, 'Download directory', { defaultValue: 'data', required: true })
    const reuseDownloads = autoYes ? true : await promptConfirm(io, 'Reuse existing downloads if present?', { initialValue: true })

    // Summary
    process.stderr.write('\n')
    ui.info('Plan:')
    const planItems: Array<[string, string]> = [
      ['Regions', `${jobs.length} (${scope})`],
      ['Collection', `${conn.database}.${collection}`],
      ['Profile', profile],
      ['Geometry', osmiumGeometryTypes ?? '(osmium default)'],
      ['Transport', importTransport],
      ['Chunk', `${chunkMb}MB`],
      ['Concurrency', String(concurrency)],
      ['Max line', `${maxLineMb}MB`],
      ['On duplicate', onDuplicate],
      ['Unsupported geom', unsupportedGeometry],
      ['Invalid JSON', invalidJson],
      ['Indexes', `before=${indexesBefore}, after=${indexesAfter}`],
      ['Download dir', outDir],
      ['Reuse downloads', reuseDownloads ? 'yes' : 'no'],
    ]
    const keyWidth = Math.max(...planItems.map(([k]) => k.length))
    for (const [k, v] of planItems) {
      ui.info(`  ${k.padEnd(keyWidth, ' ')} : ${v}`)
    }

    ui.info('Extracts:')
    const maxExtractsPreview = 20
    const preview = jobs.slice(0, maxExtractsPreview)
    for (const job of preview) {
      ui.info(`  - ${job.name} (${job.id})`)
    }
    if (jobs.length > preview.length) {
      ui.info(`  ... +${formatNumber(jobs.length - preview.length)} more`)
    }
    process.stderr.write('\n')

    if (planOnly) {
      ui.info('Plan only (--plan): nothing executed.')
      return
    }

    const proceed = autoYes ? true : await promptConfirm(io, 'Proceed?', { initialValue: true })
    if (!proceed) {
      ui.warn('Wizard cancelled.')
      return
    }

    // Execute
    ui.info(`Bootstrapping ArangoDB (indexes=${indexesBefore})...`)
    await bootstrapArango(conn, { collection, indexes: indexesBefore })

    const startedAllAt = Date.now()
    let totalSeen = 0
    let totalCreated = 0
    let totalUpdated = 0

    let jobIdx = 0
    for (const job of jobs) {
      jobIdx++
      const jobPrefix = `[${jobIdx}/${jobs.length}] ${job.name} (${job.id})`

      ui.info(jobPrefix)
      const expectedPath = expectedDownloadPath(job.url, outDir)
      const { url } = job

      let inputPath = expectedPath
      const exists = await Bun.file(expectedPath).exists()
      if (!reuseDownloads || !exists) {
        const startedAt = Date.now()
        let lastAt = startedAt
        let lastBytes = 0

        ui.info(`Downloading ${url}`)
        const dl = await downloadGeofabrikExtract(url, { outDir, baseUrl: 'https://download.geofabrik.de' }, {
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
            ui.progress(`${jobPrefix} Downloading ${formatBytes(downloadedBytes)}${total}${pctStr}${speed}`)
          },
        })
        ui.progressDone()
        inputPath = dl.path
        ui.info(`Downloaded in ${formatDurationMs(Date.now() - startedAt)}`)
      }
      else {
        ui.info(`Using existing download: ${expectedPath}`)
      }

      const osmiumIndexFile = osmiumIndexBasePath ? `${osmiumIndexBasePath}.${sanitizeFileSuffix(job.id)}` : undefined
      const osmiumIndexType = osmiumIndexFile ? `sparse_file_array,${osmiumIndexFile}` : undefined

      const startedAt = Date.now()
      const summary = await importOsm(
        conn,
        inputPath,
        {
          collection,
          adapter: 'osmium-geojsonseq',
          profile,
          chunkBytes: chunkMb * 1024 * 1024,
          maxLineBytes: maxLineMb * 1024 * 1024,
          concurrency,
          onDuplicate,
          unsupportedGeometry,
          importTransport,
          invalidJson,
          ...(osmiumIndexType ? { osmiumIndexType } : {}),
          ...(osmiumGeometryTypes ? { osmiumGeometryTypes } : {}),
        },
        {
          onProgress: (p) => {
            const elapsedMs = Date.now() - startedAt
            const elapsedSec = elapsedMs > 0 ? elapsedMs / 1000 : 0
            const rate = elapsedSec > 0 ? p.seen / elapsedSec : 0
            const rateStr = rate > 0 ? `${formatNumber(Math.round(rate))}/s` : '0/s'

            ui.progress(
              `${jobPrefix} Import ${p.phase}: `
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
          },
        },
      )
      ui.progressDone()

      totalSeen += summary.seen
      totalCreated += summary.created
      totalUpdated += summary.updated

      ui.info(
        `Imported ${job.id}: seen=${formatNumber(summary.seen)} created=${formatNumber(summary.created)} updated=${formatNumber(summary.updated)} `
        + `in ${formatDurationMs(Date.now() - startedAt)}`,
      )

      if (osmiumIndexFile) {
        // Best-effort cleanup: these files can get large for big extracts.
        await rm(osmiumIndexFile, { force: true }).catch(() => {})
      }
    }

    if (indexesAfter !== 'none') {
      ui.info(`Creating indexes (indexes=${indexesAfter})...`)
      await bootstrapArango(conn, { collection, indexes: indexesAfter })
    }

    process.stderr.write('\n')
    ui.info('Done.')
    ui.info(`Total: seen=${formatNumber(totalSeen)} created=${formatNumber(totalCreated)} updated=${formatNumber(totalUpdated)}`)
    ui.info(`Duration: ${formatDurationMs(Date.now() - startedAllAt)}`)
  }
  catch (err) {
    if (err instanceof PromptCancelledError) {
      ui.warn(err.message)
      return
    }
    throw err
  }
}

async function ensureOsmiumAvailable(
  io: { input: NodeJS.ReadStream, output: NodeJS.WriteStream },
  ui: CliUi,
  opts: { autoYes: boolean },
): Promise<void> {
  if (Bun.which('osmium'))
    return

  ui.error('Missing requirement: osmium is not in PATH.')
  ui.info('This wizard imports .osm.pbf via `osmium export -f geojsonseq`.')

  if (opts.autoYes) {
    ui.info('Install osmium-tool or run the wizard via Docker:')
    ui.info('  docker compose up -d arangodb')
    ui.info('  docker compose build importer')
    ui.info('  docker compose run --rm importer wizard')
    throw new PromptCancelledError('Missing requirement: osmium.')
  }

  const plan = detectOsmiumInstallPlan(process.platform, cmd => Bun.which(cmd))
  const installHint0 = plan?.steps[0]?.join(' ')

  const action = await promptSelect(io, 'How do you want to proceed?', [
    {
      label: plan ? `Install osmium via ${plan.name}` : 'Install osmium (manual)',
      value: 'install',
      ...(plan && installHint0 ? { hint: installHint0 } : { hint: '(see README for commands)' }),
    },
    { label: 'Use Docker importer (recommended)', value: 'docker', hint: 'osmium is included in the image' },
    { label: 'Abort', value: 'abort' },
  ], { initialValue: plan ? 'install' : 'docker', pageSize: 8, filterable: false })

  if (action === 'abort') {
    throw new PromptCancelledError('Wizard cancelled.')
  }

  if (action === 'docker') {
    process.stderr.write('\n')
    ui.info('Run the wizard inside Docker:')
    ui.info('  docker compose up -d arangodb')
    ui.info('  docker compose build importer')
    ui.info('  docker compose run --rm importer wizard')
    throw new PromptCancelledError('Use Docker importer.')
  }

  if (!plan) {
    process.stderr.write('\n')
    ui.info('Install osmium-tool and re-run the wizard. See README for platform-specific commands.')
    throw new PromptCancelledError('Missing requirement: osmium.')
  }

  process.stderr.write('\n')
  ui.info(`Installing osmium via ${plan.name}...`)
  ui.warn('This will run package-manager commands on your system and may prompt for your sudo password.')
  for (const step of plan.steps) {
    ui.info(`$ ${step.join(' ')}`)
    const proc = Bun.spawn(step, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    const exit = await proc.exited
    if (exit !== 0) {
      throw new Error(`Install step failed with exit code ${exit}: ${step.join(' ')}`)
    }
  }

  if (!Bun.which('osmium')) {
    throw new Error('osmium is still not in PATH after install. Restart your terminal and re-run the wizard.')
  }
}

function readStringFlag(flags: Record<string, CliFlagValue>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function validateScopeFlag(value: string): 'region' | 'children' | 'leaves' {
  if (value === 'region' || value === 'children' || value === 'leaves')
    return value
  throw new Error(`Invalid --scope: ${value} (expected: region|children|leaves)`)
}

function validateRegionFlag(value: string, index: GeofabrikIndex): string {
  if (index.regionsById[value])
    return value

  // Support passing a Geofabrik path or direct URL (same input format as `download`).
  const url = value.includes('://') || value.includes('/')
    ? resolveGeofabrikUrl(value, 'https://download.geofabrik.de')
    : undefined

  if (url) {
    for (const r of Object.values(index.regionsById)) {
      if (r.pbfUrl === url)
        return r.id
    }
  }

  throw new Error(`Unknown --region: ${value}`)
}

async function promptArangoConnection(
  io: { input: NodeJS.ReadStream, output: NodeJS.WriteStream },
  env: Record<string, string | undefined>,
  flags: Record<string, CliFlagValue>,
  ui: CliUi,
): Promise<ArangoConnectionConfig> {
  const url = await promptText(io, 'Arango URL', {
    defaultValue: readStringFlag(flags, 'arango-url') ?? env.ARANGO_URL ?? 'http://127.0.0.1:8529',
    required: true,
  })

  const database = await promptText(io, 'Arango database', {
    defaultValue: readStringFlag(flags, 'arango-db') ?? env.ARANGO_DB ?? 'osm',
    required: true,
  })

  const username = await promptText(io, 'Arango user', {
    defaultValue: readStringFlag(flags, 'arango-user') ?? env.ARANGO_USER ?? 'root',
    required: true,
  })

  let password = readStringFlag(flags, 'arango-pass') ?? env.ARANGO_PASS
  if (!password) {
    ui.warn('ARANGO_PASS is not set. Prompting for password (input is masked).')
    password = await promptPassword(io, 'Arango password', { required: true })
  }

  return { url, database, username, password }
}

async function promptImportScope(
  io: { input: NodeJS.ReadStream, output: NodeJS.WriteStream },
  index: GeofabrikIndex,
  regionId: string,
): Promise<'region' | 'children' | 'leaves'> {
  const directChildren = index.childrenByParentId[regionId] ?? []
  if (directChildren.length === 0)
    return 'region'

  const leafCount = collectLeafIds(index, regionId).length
  const options: Array<{ label: string, value: 'region' | 'children' | 'leaves' }> = [
    { label: `This region only (1 extract)`, value: 'region' },
    { label: `Direct children (${directChildren.length} extracts)`, value: 'children' },
    { label: `All leaves (${leafCount} extracts)`, value: 'leaves' },
  ]

  return await promptSelect(io, 'Import scope', options, { initialValue: 'children', pageSize: 8, filterable: false })
}

function buildRegionJobs(
  index: GeofabrikIndex,
  regionId: string,
  scope: 'region' | 'children' | 'leaves',
): Array<{ id: string, name: string, url: string }> {
  const regionIds = scope === 'region'
    ? [regionId]
    : scope === 'children'
      ? (index.childrenByParentId[regionId] ?? [])
      : collectLeafIds(index, regionId)

  const jobs = regionIds
    .map((id) => {
      const r = index.regionsById[id]
      if (!r?.pbfUrl)
        return undefined
      return {
        id,
        name: r.name,
        url: r.pbfUrl,
      }
    })
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))

  return jobs
}

function expectedDownloadPath(url: string, outDir: string): string {
  const fileName = url.split('/').pop() ?? 'extract.osm.pbf'
  const cleanOutDir = outDir.replace(/\/+$/, '')
  return `${cleanOutDir}/${fileName}`
}

function collectLeafIds(
  index: GeofabrikIndex,
  regionId: string,
): string[] {
  const leaves: string[] = []
  const stack = [regionId]

  while (stack.length > 0) {
    const id = stack.pop()
    if (!id)
      continue
    const kids = index.childrenByParentId[id] ?? []
    if (kids.length === 0) {
      leaves.push(id)
      continue
    }
    stack.push(...kids)
  }

  return leaves
}

async function pickGeofabrikRegion(
  io: { input: NodeJS.ReadStream, output: NodeJS.WriteStream },
  index: GeofabrikIndex,
): Promise<string> {
  let currentId: string | undefined

  for (;;) {
    const current = currentId ? index.regionsById[currentId] : undefined
    const path = currentId ? formatRegionPath(index, currentId) : 'Geofabrik'
    const childIds = currentId ? (index.childrenByParentId[currentId] ?? []) : index.rootIds

    const options: Array<{ label: string, value: string, hint?: string, disabled?: boolean }> = []

    if (currentId) {
      options.push({
        label: `Use: ${current?.name ?? currentId}`,
        value: '__wizard_select__',
        hint: current?.pbfUrl ? '(downloadable)' : '(no .pbf)',
        disabled: !current?.pbfUrl,
      })
      options.push({
        label: '.. back',
        value: '__wizard_back__',
        ...(!current?.parentId ? { hint: '(root)' } : {}),
        disabled: !current?.parentId,
      })
    }

    for (const id of childIds) {
      const r = index.regionsById[id]
      const name = r?.name ?? id
      const kids = index.childrenByParentId[id]?.length ?? 0
      const hint = kids > 0 ? `${kids} children` : 'leaf'
      options.push({
        label: name,
        value: id,
        hint,
      })
    }

    const choice = await promptSelect(
      io,
      `${path} (enter to open; type to filter)`,
      options,
      { pageSize: 18 },
    )

    if (choice === '__wizard_select__' && currentId) {
      return currentId
    }
    if (choice === '__wizard_back__') {
      currentId = current?.parentId
      continue
    }

    currentId = choice
  }
}

function formatRegionPath(
  index: GeofabrikIndex,
  regionId: string,
): string {
  const parts: string[] = []
  const seen = new Set<string>()
  let cur: string | undefined = regionId

  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const r: GeofabrikRegion | undefined = index.regionsById[cur]
    parts.push(r?.name ?? cur)
    cur = r?.parentId
  }

  return parts.reverse().join(' / ')
}

function sanitizeFileSuffix(input: string): string {
  return input.replace(/[^\w.\-]+/g, '_')
}
