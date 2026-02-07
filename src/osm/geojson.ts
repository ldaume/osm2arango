export const arangoSupportedGeoJsonGeometryTypes = [
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
] as const

export type ArangoSupportedGeoJsonGeometryType = typeof arangoSupportedGeoJsonGeometryTypes[number]

const supported = new Set<string>(arangoSupportedGeoJsonGeometryTypes)

export function isArangoSupportedGeoJsonGeometryType(
  type: string,
): type is ArangoSupportedGeoJsonGeometryType {
  return supported.has(type)
}
