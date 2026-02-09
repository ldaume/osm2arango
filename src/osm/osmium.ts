import type { OsmFeatureDoc } from './feature.ts'
import { assertRecord, isRecord } from '../util/guards.ts'

export interface OsmiumAdapterOptions {
  osmiumPath?: string
  /**
   * See `osmium export --help` / `man osmium-export`:
   * `--index-type` controls the node-location index (memory vs file based).
   * This can be critical for large extracts (e.g. germany/planet) to avoid OOM kills.
   */
  indexType?: string
  /**
   * Comma-separated list for `osmium export --geometry-types`, e.g. "point,polygon".
   * Useful to drop noisy geometries early (e.g. roads as LineStrings).
   */
  geometryTypes?: string
  /**
   * Path to an osmium export config JSON (`--config`).
   * Useful for include/exclude tag filtering to reduce output volume.
   */
  configPath?: string
}

export function buildOsmiumExportArgs(inputPath: string, opts?: OsmiumAdapterOptions): string[] {
  const args = [
    'export',
    inputPath,
    '-f',
    'geojsonseq',
    '-x',
    'print_record_separator=false',
    '--add-unique-id=type_id',
    '--attributes=type,id,version,changeset,timestamp,uid,user',
  ]

  if (opts?.indexType) {
    args.push('--index-type', opts.indexType)
  }

  if (opts?.geometryTypes) {
    args.push('--geometry-types', opts.geometryTypes)
  }

  if (opts?.configPath) {
    args.push('--config', opts.configPath)
  }

  return args
}

export function spawnOsmiumExport(inputPath: string, opts?: OsmiumAdapterOptions): Bun.Subprocess {
  const cmd = opts?.osmiumPath ?? 'osmium'
  const args = buildOsmiumExportArgs(inputPath, opts)

  return Bun.spawn([cmd, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  })
}

export function osmiumGeoJsonFeatureToDoc(feature: unknown): OsmFeatureDoc {
  const f = assertRecord(feature, 'feature')
  const geometry = assertRecord(f.geometry, 'feature.geometry')
  const properties = assertRecord(f.properties, 'feature.properties')

  const key = typeof f.id === 'string' && f.id.length > 0 ? f.id : deriveFallbackKey(properties)

  const geometryType = typeof geometry.type === 'string' ? geometry.type : undefined
  if (!geometryType)
    throw new Error('feature.geometry.type must be a string')
  const normalizedGeometry: OsmFeatureDoc['geometry'] = {
    type: geometryType,
    ...(geometry.coordinates !== undefined ? { coordinates: geometry.coordinates } : {}),
    ...(geometry.geometries !== undefined ? { geometries: geometry.geometries } : {}),
  }

  const tags = normalizeTags(properties)
  const tagsKeys = Object.keys(tags)
  const tagsKV = tagsKeys.map(k => `${k}=${tags[k]}`)

  const osm: OsmFeatureDoc['osm'] = {}
  const p = properties as Record<string, unknown>
  if (typeof p['@type'] === 'string')
    osm.type = p['@type']
  else if (typeof p.type === 'string')
    osm.type = p.type

  if (typeof p['@id'] === 'number')
    osm.id = p['@id']
  else if (typeof p.id === 'number')
    osm.id = p.id

  if (typeof p['@version'] === 'number')
    osm.version = p['@version']
  else if (typeof p.version === 'number')
    osm.version = p.version

  if (typeof p['@changeset'] === 'number')
    osm.changeset = p['@changeset']
  else if (typeof p.changeset === 'number')
    osm.changeset = p.changeset

  if (typeof p['@timestamp'] === 'number')
    osm.timestamp = p['@timestamp']
  else if (typeof p.timestamp === 'number')
    osm.timestamp = p.timestamp

  if (typeof p['@uid'] === 'number')
    osm.uid = p['@uid']
  else if (typeof p.uid === 'number')
    osm.uid = p.uid

  if (typeof p['@user'] === 'string')
    osm.user = p['@user']
  else if (typeof p.user === 'string')
    osm.user = p.user

  return {
    _key: sanitizeArangoKey(key),
    geometry: normalizedGeometry,
    tags,
    tagsKeys,
    tagsKV,
    osm,
  }
}

function deriveFallbackKey(properties: Record<string, unknown>): string {
  const t = typeof properties['@type'] === 'string'
    ? properties['@type']
    : typeof properties.type === 'string'
      ? properties.type
      : 'x'

  const id = typeof properties['@id'] === 'number'
    ? String(properties['@id'])
    : typeof properties.id === 'number'
      ? String(properties.id)
      : '0'

  const prefix = t.length > 0 ? t[0] : 'x'
  return `${prefix}${id}`
}

function sanitizeArangoKey(key: string): string {
  // Sanitize for ArangoDB _key constraints.
  return key.replace(/[^\w:\-.]/g, '_')
}

function normalizeTags(properties: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {}

  // Preferred: osmium with `-x tags_type=array` puts tags into `properties.tags`.
  const rawTags = properties.tags
  if (Array.isArray(rawTags)) {
    for (const t of rawTags) {
      if (!isRecord(t))
        continue
      const k = typeof t.k === 'string' ? t.k : typeof t.key === 'string' ? t.key : undefined
      const v0 = t.v ?? t.value
      const v
        = typeof v0 === 'string'
          ? v0
          : typeof v0 === 'number' || typeof v0 === 'boolean'
            ? String(v0)
            : undefined
      if (!k || v === undefined)
        continue
      tags[k] = v
    }
    return tags
  }

  // Fallback: tags embedded directly in properties (key/value pairs).
  const reserved = new Set([
    'type',
    'id',
    'version',
    'changeset',
    'timestamp',
    'uid',
    'user',
    '@type',
    '@id',
    '@version',
    '@changeset',
    '@timestamp',
    '@uid',
    '@user',
    'tags',
  ])

  for (const [k, v] of Object.entries(properties)) {
    if (reserved.has(k))
      continue
    if (typeof v === 'string')
      tags[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean')
      tags[k] = String(v)
  }

  return tags
}
