import { describe, expect, test } from 'bun:test'
import { buildOsmiumExportArgs, osmiumGeoJsonFeatureToDoc } from '../src/osm/osmium.ts'

describe('osmiumGeoJsonFeatureToDoc()', () => {
  test('derives a fallback key and sanitizes invalid characters', () => {
    // Given
    const feature = {
      type: 'Feature',
      properties: {
        type: 'node',
        id: 123,
        tags: [{ k: 'amenity', v: 'cafe' }],
      },
      // Will be sanitized to "n_123"
      id: 'n 123',
      geometry: { type: 'Point', coordinates: [13.4, 52.5] },
    }

    // When
    const doc = osmiumGeoJsonFeatureToDoc(feature)

    // Then
    expect(doc._key).toBe('n_123')
  })

  test('derives a fallback key when feature.id is missing', () => {
    // Given
    const feature = {
      type: 'Feature',
      properties: { type: 'node', id: 123 },
      geometry: { type: 'Point', coordinates: [0, 0] },
    }

    // When
    const doc = osmiumGeoJsonFeatureToDoc(feature)

    // Then
    expect(doc._key).toBe('n123')
  })

  test('converts GeoJSON Feature with tags array', () => {
    // Given
    const feature = {
      type: 'Feature',
      id: 'n123',
      properties: {
        type: 'node',
        id: 123,
        tags: [
          { k: 'amenity', v: 'cafe' },
          { key: 'name', value: 'Cafe Foo' },
        ],
      },
      geometry: { type: 'Point', coordinates: [13.4, 52.5] },
    }

    // When
    const doc = osmiumGeoJsonFeatureToDoc(feature)

    // Then
    expect(doc._key).toBe('n123')
    expect(doc.osm.type).toBe('node')
    expect(doc.osm.id).toBe(123)
    expect(doc.tags.amenity).toBe('cafe')
    expect(doc.tags.name).toBe('Cafe Foo')
    expect(doc.tagsKeys).toContain('amenity')
    expect(doc.tagsKV).toContain('amenity=cafe')
    expect(doc.geometry.type).toBe('Point')
  })

  test('converts GeoJSON Feature with embedded tag properties', () => {
    // Given
    const feature = {
      type: 'Feature',
      id: 'n1',
      properties: {
        type: 'node',
        id: 1,
        name: 'X',
        amenity: 'bar',
      },
      geometry: { type: 'Point', coordinates: [0, 0] },
    }

    // When
    const doc = osmiumGeoJsonFeatureToDoc(feature)

    // Then
    expect(doc.tags.name).toBe('X')
    expect(doc.tags.amenity).toBe('bar')
  })

  test('stringifies non-string tag values when present', () => {
    // Given
    const feature = {
      type: 'Feature',
      id: 'n1',
      properties: {
        type: 'node',
        id: 1,
        height: 7,
        wheelchair: false,
      },
      geometry: { type: 'Point', coordinates: [0, 0] },
    }

    // When
    const doc = osmiumGeoJsonFeatureToDoc(feature)

    // Then
    expect(doc.tags.height).toBe('7')
    expect(doc.tags.wheelchair).toBe('false')
  })

  test('stores @attributes in `osm` and does not treat them as tags', () => {
    // Given
    const feature = {
      type: 'Feature',
      id: 'n1',
      properties: {
        '@type': 'node',
        '@id': 1,
        '@timestamp': 1700000000,
        'amenity': 'cafe',
        'name': 'Cafe X',
      },
      geometry: { type: 'Point', coordinates: [0, 0] },
    }

    // When
    const doc = osmiumGeoJsonFeatureToDoc(feature)

    // Then
    expect(doc.osm.type).toBe('node')
    expect(doc.osm.id).toBe(1)
    expect(doc.osm.timestamp).toBe(1700000000)
    expect(doc.tags.amenity).toBe('cafe')
    expect(doc.tags.name).toBe('Cafe X')
    expect(doc.tags['@type']).toBeUndefined()
    expect(doc.tags['@id']).toBeUndefined()
    expect(doc.tags['@timestamp']).toBeUndefined()
    expect(doc.tagsKV.some(v => v.startsWith('@'))).toBe(false)
  })

  test('throws if geometry.type is missing', () => {
    // Given
    const feature = {
      type: 'Feature',
      id: 'n1',
      properties: { type: 'node', id: 1 },
      geometry: { coordinates: [0, 0] },
    }

    // When / Then
    expect(() => osmiumGeoJsonFeatureToDoc(feature)).toThrow('feature.geometry.type must be a string')
  })
})

describe('buildOsmiumExportArgs()', () => {
  test('builds the expected geojsonseq args', () => {
    // Given
    const inputPath = 'data/berlin-latest.osm.pbf'

    // When
    const args = buildOsmiumExportArgs(inputPath)

    // Then
    expect(args).toEqual([
      'export',
      inputPath,
      '-f',
      'geojsonseq',
      '-x',
      'print_record_separator=false',
      '--add-unique-id=type_id',
      '--attributes=type,id,version,changeset,timestamp,uid,user',
    ])
  })

  test('can include --index-type when configured', () => {
    // Given
    const inputPath = 'data/berlin-latest.osm.pbf'

    // When
    const args = buildOsmiumExportArgs(inputPath, { indexType: 'sparse_file_array,/tmp/osmium.idx' })

    // Then
    expect(args).toContain('--index-type')
    expect(args).toContain('sparse_file_array,/tmp/osmium.idx')
  })

  test('can include --geometry-types when configured', () => {
    // Given
    const inputPath = 'data/berlin-latest.osm.pbf'

    // When
    const args = buildOsmiumExportArgs(inputPath, { geometryTypes: 'point,polygon' })

    // Then
    expect(args).toContain('--geometry-types')
    expect(args).toContain('point,polygon')
  })

  test('can include --config when configured', () => {
    // Given
    const inputPath = 'data/berlin-latest.osm.pbf'

    // When
    const args = buildOsmiumExportArgs(inputPath, { configPath: '/tmp/osmium-export.json' })

    // Then
    expect(args).toContain('--config')
    expect(args).toContain('/tmp/osmium-export.json')
  })
})
