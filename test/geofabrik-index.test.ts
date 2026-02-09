import { describe, expect, test } from 'bun:test'

import { parseGeofabrikIndex } from '../src/domain/geofabrik-index.ts'

describe('parseGeofabrikIndex()', () => {
  test('builds root/child relationships and sorts by name', () => {
    // Given
    const input = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            id: 'europe',
            name: 'Europe',
            urls: { pbf: 'https://download.geofabrik.de/europe-latest.osm.pbf' },
          },
        },
        {
          type: 'Feature',
          properties: {
            id: 'asia',
            name: 'Asia',
            urls: { pbf: 'https://download.geofabrik.de/asia-latest.osm.pbf' },
          },
        },
        {
          type: 'Feature',
          properties: {
            id: 'germany',
            parent: 'europe',
            name: 'Germany',
            urls: { pbf: 'https://download.geofabrik.de/europe/germany-latest.osm.pbf' },
          },
        },
        {
          type: 'Feature',
          properties: {
            id: 'albania',
            parent: 'europe',
            name: 'Albania',
            urls: { pbf: 'https://download.geofabrik.de/europe/albania-latest.osm.pbf' },
          },
        },
      ],
    }

    // When
    const index = parseGeofabrikIndex(input)

    // Then
    expect(index.rootIds).toEqual(['asia', 'europe'])
    expect(index.childrenByParentId.europe).toEqual(['albania', 'germany'])
    expect(index.regionsById.germany?.pbfUrl).toBe('https://download.geofabrik.de/europe/germany-latest.osm.pbf')
  })
})
