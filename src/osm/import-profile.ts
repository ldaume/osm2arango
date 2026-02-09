import type { OsmFeatureDoc } from './feature.ts'

export type ImportProfile = 'all' | 'places' | 'amenities' | 'recreation'

const RECREATION_NATURAL_VALUES = new Set([
  'wood',
  'water',
  'wetland',
  'beach',
  'grassland',
  'heath',
  'scrub',
])

const RECREATION_LANDUSE_VALUES = new Set([
  'forest',
  'meadow',
  'grass',
  'recreation_ground',
  'village_green',
  'allotments',
])

export function shouldImportFeatureForProfile(doc: OsmFeatureDoc, profile: ImportProfile): boolean {
  if (profile === 'all')
    return true

  const tags = doc.tags

  if (profile === 'amenities') {
    return typeof tags.amenity === 'string' && tags.amenity.length > 0
  }

  const isRecreation = isRecreationFeature(tags)

  if (profile === 'recreation')
    return isRecreation

  // places = amenities + recreation
  return (
    (typeof tags.amenity === 'string' && tags.amenity.length > 0)
    || isRecreation
  )
}

function isRecreationFeature(tags: Record<string, string>): boolean {
  if (typeof tags.leisure === 'string' && tags.leisure.length > 0)
    return true

  if (typeof tags.waterway === 'string' && tags.waterway.length > 0)
    return true

  const natural = tags.natural
  if (typeof natural === 'string' && RECREATION_NATURAL_VALUES.has(natural))
    return true

  const landuse = tags.landuse
  if (typeof landuse === 'string' && RECREATION_LANDUSE_VALUES.has(landuse))
    return true

  // Common protected-area tag. Helpful for later "how green is the area" scoring.
  if (tags.boundary === 'national_park' || tags.boundary === 'protected_area')
    return true

  return false
}
