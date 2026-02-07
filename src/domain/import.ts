import type { ArangoConnectionConfig } from '../config.ts'
import type { OsmFeatureDoc } from '../osm/feature.ts'
import { createArangoClient as createArangoClientLive } from '../arango/arango.data.ts'
import { isArangoSupportedGeoJsonGeometryType } from '../osm/geojson.ts'
import { osmiumGeoJsonFeatureToDoc, spawnOsmiumExport } from '../osm/osmium.ts'
import { createDocumentChunker } from '../util/document-chunker.ts'
import { readLines } from '../util/lines.ts'

export type ImportAdapter = 'osmium-geojsonseq' | 'ndjson'

export type UnsupportedGeometryMode = 'skip' | 'keep' | 'error'

export type ImportPhase = 'reading' | 'importing' | 'finalizing' | 'done'

export interface ImportProgress {
  phase: ImportPhase
  adapter: ImportAdapter
  seen: number
  created: number
  updated: number
  ignored: number
  empty: number
  errors: number
  skippedUnsupportedGeometry: number
  inFlight: number
  unsupportedGeometryMode: UnsupportedGeometryMode
}

export interface ImportDeps {
  createArangoClient?: typeof createArangoClientLive
  onProgress?: (progress: ImportProgress) => void
  now?: () => number
  progressIntervalMs?: number
}

export interface ImportOptions {
  collection: string
  adapter: ImportAdapter
  chunkBytes: number
  concurrency: number
  onDuplicate: 'error' | 'update' | 'replace' | 'ignore'
  unsupportedGeometry?: UnsupportedGeometryMode
}

export interface ImportSummary {
  seen: number
  created: number
  updated: number
  ignored: number
  empty: number
  errors: number
  skippedUnsupportedGeometry: number
  unsupportedGeometryMode: UnsupportedGeometryMode
  geometryTypeCounts: Record<string, number>
  unsupportedGeometryTypeCounts: Record<string, number>
}

export async function importOsm(
  conn: ArangoConnectionConfig,
  inputPath: string,
  opts: ImportOptions,
  deps?: ImportDeps,
): Promise<ImportSummary> {
  const inputFile = Bun.file(inputPath)
  if (!(await inputFile.exists())) {
    throw new Error(`Input file not found: ${inputPath}`)
  }

  const createClient = deps?.createArangoClient ?? createArangoClientLive
  const dbClient = await createClient({
    url: conn.url,
    database: conn.database,
    username: conn.username,
    password: conn.password,
  })

  const info = await dbClient.getCollectionInfo(opts.collection)
  if (!info) {
    throw new Error(`Collection not found: ${opts.collection}. Run: osm2arango bootstrap`)
  }

  const importer = createDocumentChunker<OsmFeatureDoc>(opts.chunkBytes)
  const inFlight = new Set<Promise<void>>()
  const unsupportedGeometryMode = opts.unsupportedGeometry ?? 'skip'

  const now = deps?.now ?? Date.now
  const progressIntervalMs = deps?.progressIntervalMs ?? 1000
  let lastProgressAt = 0

  let seen = 0
  let created = 0
  let updated = 0
  let ignored = 0
  let empty = 0
  let errors = 0
  let skippedUnsupportedGeometry = 0

  const geometryTypeCounts: Record<string, number> = {}
  const unsupportedGeometryTypeCounts: Record<string, number> = {}

  const reportProgress = (phase: ImportPhase, force: boolean): void => {
    if (!deps?.onProgress)
      return
    const t = now()
    if (!force && t - lastProgressAt < progressIntervalMs)
      return
    lastProgressAt = t

    deps.onProgress({
      phase,
      adapter: opts.adapter,
      seen,
      created,
      updated,
      ignored,
      empty,
      errors,
      skippedUnsupportedGeometry,
      inFlight: inFlight.size,
      unsupportedGeometryMode,
    })
  }

  const enqueueChunk = async (chunk: OsmFeatureDoc[]): Promise<void> => {
    const p = dbClient
      .importDocuments(opts.collection, chunk, { onDuplicate: opts.onDuplicate })
      .then((res) => {
        created += res.created ?? 0
        updated += res.updated ?? 0
        ignored += res.ignored ?? 0
        empty += res.empty ?? 0
        errors += res.errors ?? 0

        reportProgress('importing', false)
      })

    inFlight.add(p)
    p.finally(() => inFlight.delete(p)).catch(() => {})

    while (inFlight.size >= opts.concurrency) {
      await Promise.race(inFlight)
    }
  }

  const pushDoc = async (doc: OsmFeatureDoc): Promise<void> => {
    const chunk = importer.push(doc)
    if (chunk)
      await enqueueChunk(chunk)
  }

  const trackAndMaybeSkip = (doc: OsmFeatureDoc): boolean => {
    // Keep input robust; NDJSON adapter allows "passthrough" documents.
    const rawType = (doc.geometry as { type?: unknown }).type
    const geometryType = typeof rawType === 'string' && rawType.length > 0 ? rawType : 'unknown'

    seen++
    geometryTypeCounts[geometryType] = (geometryTypeCounts[geometryType] ?? 0) + 1

    if (isArangoSupportedGeoJsonGeometryType(geometryType))
      return false

    unsupportedGeometryTypeCounts[geometryType] = (unsupportedGeometryTypeCounts[geometryType] ?? 0) + 1

    if (unsupportedGeometryMode === 'keep')
      return false
    if (unsupportedGeometryMode === 'error') {
      throw new Error(
        `Unsupported GeoJSON geometry type: ${geometryType}. `
        + `ArangoDB geo indexes / Geo utility functions require GeoJSON Geometry Objects like Point/Polygon/MultiPolygon. `
        + `Use --unsupported-geometry=skip (default) or --unsupported-geometry=keep.`,
      )
    }

    // skip
    skippedUnsupportedGeometry++
    reportProgress('reading', false)
    return true
  }

  reportProgress('reading', true)

  if (opts.adapter === 'ndjson') {
    const stream = inputFile.stream()
    for await (const line0 of readLines(stream)) {
      const line = stripRecordSeparator(line0).trim()
      if (!line)
        continue
      const parsed = JSON.parse(line) as unknown
      const doc = normalizeInputToDoc(parsed)
      if (trackAndMaybeSkip(doc))
        continue
      reportProgress('reading', false)
      await pushDoc(doc)
    }
  }
  else if (opts.adapter === 'osmium-geojsonseq') {
    let proc: Bun.Subprocess
    try {
      proc = spawnOsmiumExport(inputPath)
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        'Failed to start osmium. '
        + 'To import .osm.pbf you need osmium-tool (binary: osmium) in $PATH. '
        + 'If you already have a .ndjson file (one GeoJSON Feature per line), import it with --adapter=ndjson. '
        + `(${msg})`,
      )
    }
    if (!proc.stdout) {
      throw new Error('Failed to spawn osmium (stdout missing). Is osmium installed?')
    }

    if (typeof proc.stdout === 'number') {
      throw new TypeError('Failed to spawn osmium (stdout is not a stream).')
    }

    for await (const line0 of readLines(proc.stdout)) {
      const line = stripRecordSeparator(line0).trim()
      if (!line)
        continue
      const parsed = JSON.parse(line) as unknown
      const doc = osmiumGeoJsonFeatureToDoc(parsed)
      if (trackAndMaybeSkip(doc))
        continue
      reportProgress('reading', false)
      await pushDoc(doc)
    }

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`osmium export failed with exit code ${exitCode}`)
    }
  }
  else {
    throw new Error(`Unknown adapter: ${opts.adapter}`)
  }

  const final = importer.flush()
  if (final)
    await enqueueChunk(final)

  reportProgress('finalizing', true)
  await Promise.all(inFlight)
  reportProgress('done', true)

  // Minimal reporting for now; callers can wrap this.
  if (errors > 0) {
    throw new Error(`Import finished with errors: ${errors} (created: ${created}, updated: ${updated})`)
  }

  return {
    seen,
    created,
    updated,
    ignored,
    empty,
    errors,
    skippedUnsupportedGeometry,
    unsupportedGeometryMode,
    geometryTypeCounts,
    unsupportedGeometryTypeCounts,
  }
}

function stripRecordSeparator(line: string): string {
  return line.length > 0 && line.charCodeAt(0) === 0x1E ? line.slice(1) : line
}

function normalizeInputToDoc(value: unknown): OsmFeatureDoc {
  // Accept either:
  // 1) A GeoJSON Feature (osmium format) -> convert
  // 2) Already normalized OsmFeatureDoc -> pass through
  if (typeof value !== 'object' || value === null) {
    throw new Error('NDJSON line must be a JSON object')
  }

  const v = value as Partial<OsmFeatureDoc> & { type?: unknown }
  if (typeof v._key === 'string' && typeof v.geometry === 'object' && v.geometry !== null) {
    // Shallow validation; import is not a schema validator.
    const geometry = v.geometry as { type?: unknown }
    if (typeof geometry.type !== 'string' || geometry.type.length === 0) {
      throw new Error('NDJSON document geometry.type must be a non-empty string')
    }
    return v as OsmFeatureDoc
  }

  if (v.type === 'Feature') {
    return osmiumGeoJsonFeatureToDoc(value)
  }

  throw new Error('Unsupported NDJSON document shape')
}
