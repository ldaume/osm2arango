import { describe, expect, test } from 'bun:test'
import { bootstrapArango } from '../src/domain/bootstrap.ts'

describe('bootstrapArango()', () => {
  test('creates db + collection + indexes', async () => {
    // Given
    const calls: string[] = []

    const createArangoClient = async ({ database }: { database: string }) => {
      calls.push(`createClient:${database}`)
      return {
        ensureDatabase: async (name: string) => calls.push(`ensureDatabase:${database}:${name}`),
        ensureCollection: async (name: string) => calls.push(`ensureCollection:${database}:${name}`),
        getCollectionInfo: async () => null,
        ensureGeoIndex: async (collection: string, fields: [string], geoJson: boolean, name?: string) => {
          calls.push(`ensureGeoIndex:${database}:${collection}:${fields.join(',')}:${String(geoJson)}:${name ?? ''}`)
        },
        ensurePersistentIndex: async (collection: string, fields: string[], sparse: boolean, name?: string) => {
          calls.push(`ensurePersistentIndex:${database}:${collection}:${fields.join(',')}:${String(sparse)}:${name ?? ''}`)
        },
        importDocuments: async () => ({ created: 0, errors: 0 }),
      }
    }

    // When
    await bootstrapArango(
      { url: 'http://127.0.0.1:8529', database: 'osm', username: 'root', password: 'pw' },
      { collection: 'osm_features' },
      { createArangoClient: createArangoClient as any },
    )

    // Then
    expect(calls).toContain('createClient:_system')
    expect(calls).toContain('createClient:osm')
    expect(calls).toContain('ensureDatabase:_system:osm')
    expect(calls).toContain('ensureCollection:osm:osm_features')
    expect(calls).toContain('ensureGeoIndex:osm:osm_features:geometry:true:geometry_geo')
    expect(calls).toContain('ensurePersistentIndex:osm:osm_features:tagsKeys[*]:true:tagsKeys_arr')
    expect(calls).toContain('ensurePersistentIndex:osm:osm_features:tagsKV[*]:true:tagsKV_arr')
  })
})
