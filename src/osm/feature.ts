export interface GeoJsonGeometry {
  type: string
  coordinates?: unknown
  geometries?: unknown
}

export interface OsmCore {
  type?: string
  id?: number
  version?: number
  changeset?: number
  /**
   * Unix timestamp (seconds since epoch). From osmium export: `@timestamp`.
   */
  timestamp?: number
  uid?: number
  user?: string
}

export interface OsmFeatureDoc {
  _key: string
  geometry: GeoJsonGeometry
  tags: Record<string, string>
  tagsKeys: string[]
  tagsKV: string[]
  osm: OsmCore
}
