import type { OsmFeatureDoc } from './feature.ts'
import { assertRecord, isRecord } from '../util/guards.ts'

export interface OsmiumAdapterOptions {
  osmiumPath?: string
}

export function buildOsmiumExportArgs(inputPath: string): string[] {
  return [
    'export',
    inputPath,
    '-f',
    'geojsonseq',
    '-x',
    'print_record_separator=false',
    '-x',
    'tags_type=array',
    '--add-unique-id=type_id',
    '--attributes=type,id,version,changeset,timestamp,uid,user',
  ]
}

export function spawnOsmiumExport(inputPath: string, opts?: OsmiumAdapterOptions): Bun.Subprocess {
  const cmd = opts?.osmiumPath ?? 'osmium'
  const args = buildOsmiumExportArgs(inputPath)

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
  if (typeof properties.type === 'string')
    osm.type = properties.type
  if (typeof properties.id === 'number')
    osm.id = properties.id
  if (typeof properties.version === 'number')
    osm.version = properties.version
  if (typeof properties.changeset === 'number')
    osm.changeset = properties.changeset
  if (typeof properties.timestamp === 'string')
    osm.timestamp = properties.timestamp
  if (typeof properties.uid === 'number')
    osm.uid = properties.uid
  if (typeof properties.user === 'string')
    osm.user = properties.user

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
  const t = typeof properties.type === 'string' ? properties.type : 'x'
  const id = typeof properties.id === 'number' ? String(properties.id) : '0'
  const prefix = t.length > 0 ? t[0] : 'x'
  return `${prefix}${id}`
}

function sanitizeArangoKey(key: string): string {
  // ArangoDB _key constraints are strict; keep it conservative for now.
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
      const v = typeof t.v === 'string' ? t.v : typeof t.value === 'string' ? t.value : undefined
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
    'tags',
  ])

  for (const [k, v] of Object.entries(properties)) {
    if (reserved.has(k))
      continue
    if (typeof v === 'string')
      tags[k] = v
  }

  return tags
}
