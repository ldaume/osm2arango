import type { FetchLike } from '../util/fetch.ts'

import { assertRecord, isRecord } from '../util/guards.ts'

export interface GeofabrikRegion {
  id: string
  name: string
  parentId?: string
  pbfUrl?: string
}

export interface GeofabrikIndex {
  regionsById: Record<string, GeofabrikRegion>
  childrenByParentId: Record<string, string[]>
  rootIds: string[]
}

export interface LoadGeofabrikIndexDeps {
  fetch?: FetchLike
}

export async function loadGeofabrikIndex(deps?: LoadGeofabrikIndexDeps): Promise<GeofabrikIndex> {
  const fetchFn = deps?.fetch ?? fetch

  const sources = [
    'https://download.geofabrik.de/index-v1-nogeom.json',
    'https://download.geofabrik.de/index-v1.json',
  ] as const

  let lastErr: Error | undefined
  for (const url of sources) {
    try {
      const res = await fetchFn(url)
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as unknown
      return parseGeofabrikIndex(json)
    }
    catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw new Error(`Failed to download Geofabrik index. ${lastErr ? `Last error: ${lastErr.message}` : ''}`.trim())
}

export function parseGeofabrikIndex(value: unknown): GeofabrikIndex {
  const root = assertRecord(value, 'index')
  const features = root.features
  if (!Array.isArray(features)) {
    throw new TypeError('index.features must be an array')
  }

  const regions: GeofabrikRegion[] = []

  for (let i = 0; i < features.length; i++) {
    const f = assertRecord(features[i], `index.features[${i}]`)
    const props = assertRecord(f.properties, `index.features[${i}].properties`)

    const id = typeof props.id === 'string' && props.id.length > 0 ? props.id : undefined
    if (!id)
      throw new TypeError(`index.features[${i}].properties.id must be a non-empty string`)

    const name = typeof props.name === 'string' && props.name.length > 0 ? props.name : id
    const parentId = typeof props.parent === 'string' && props.parent.length > 0 ? props.parent : undefined

    let pbfUrl: string | undefined
    if (isRecord(props.urls) && typeof props.urls.pbf === 'string' && props.urls.pbf.length > 0) {
      pbfUrl = props.urls.pbf
    }

    regions.push({
      id,
      name,
      ...(parentId ? { parentId } : {}),
      ...(pbfUrl ? { pbfUrl } : {}),
    })
  }

  return buildGeofabrikIndex(regions)
}

function buildGeofabrikIndex(regions: GeofabrikRegion[]): GeofabrikIndex {
  const regionsById: Record<string, GeofabrikRegion> = {}
  for (const r of regions) {
    if (regionsById[r.id]) {
      throw new Error(`Duplicate Geofabrik region id: ${r.id}`)
    }
    regionsById[r.id] = r
  }

  const childrenByParentId: Record<string, string[]> = {}
  const rootIds: string[] = []

  for (const r of regions) {
    if (r.parentId) {
      (childrenByParentId[r.parentId] ??= []).push(r.id)
    }
    else {
      rootIds.push(r.id)
    }
  }

  const collator = new Intl.Collator('en', { sensitivity: 'base' })
  const byName = (a: string, b: string): number => {
    const ra = regionsById[a]
    const rb = regionsById[b]
    return collator.compare(ra?.name ?? a, rb?.name ?? b)
  }

  rootIds.sort(byName)
  for (const ids of Object.values(childrenByParentId)) {
    ids.sort(byName)
  }

  return { regionsById, childrenByParentId, rootIds }
}
