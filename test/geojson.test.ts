import { describe, expect, test } from 'bun:test'
import { isArangoSupportedGeoJsonGeometryType } from '../src/osm/geojson.ts'

interface Case {
  name: string
  given: { type: string }
  then: { supported: boolean }
}

const cases: Case[] = [
  { name: 'Point supported', given: { type: 'Point' }, then: { supported: true } },
  { name: 'MultiPoint supported', given: { type: 'MultiPoint' }, then: { supported: true } },
  { name: 'LineString supported', given: { type: 'LineString' }, then: { supported: true } },
  { name: 'MultiLineString supported', given: { type: 'MultiLineString' }, then: { supported: true } },
  { name: 'Polygon supported', given: { type: 'Polygon' }, then: { supported: true } },
  { name: 'MultiPolygon supported', given: { type: 'MultiPolygon' }, then: { supported: true } },
  { name: 'GeometryCollection unsupported', given: { type: 'GeometryCollection' }, then: { supported: false } },
  { name: 'Feature unsupported', given: { type: 'Feature' }, then: { supported: false } },
  { name: 'empty string unsupported', given: { type: '' }, then: { supported: false } },
  { name: 'random string unsupported', given: { type: 'Foo' }, then: { supported: false } },
]

describe('isArangoSupportedGeoJsonGeometryType()', () => {
  test.each(cases)('$name', ({ given, then }) => {
    // Given
    const { type } = given

    // When
    const supported = isArangoSupportedGeoJsonGeometryType(type)

    // Then
    expect(supported).toBe(then.supported)
  })
})
