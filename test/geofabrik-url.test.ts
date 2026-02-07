import { describe, expect, test } from 'bun:test'
import { resolveGeofabrikUrl } from '../src/domain/download.ts'

describe('resolveGeofabrikUrl()', () => {
  test('keeps full URLs', () => {
    // Given
    const input = 'https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf'

    // When
    const url = resolveGeofabrikUrl(input, 'https://download.geofabrik.de')

    // Then
    expect(url).toBe(input)
  })

  test('adds -latest.osm.pbf for region paths', () => {
    // Given
    const input = 'europe/germany/berlin'

    // When
    const url = resolveGeofabrikUrl(input, 'https://download.geofabrik.de/')

    // Then
    expect(url).toBe('https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf')
  })
})
