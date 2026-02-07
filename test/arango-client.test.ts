import { describe, expect, test } from 'bun:test'
import { ArangoApiError, createArangoClient } from '../src/arango/arango.data.ts'

describe('createArangoClient()', () => {
  test('ensureDatabase() ignores 409 conflicts', async () => {
    // Given
    const { client, state } = await createClient({
      createDatabaseError: { code: 409 },
    })

    // When
    await client.ensureDatabase('osm')

    // Then
    expect(state.createDatabaseCalls).toEqual(['osm'])
  })

  test('getCollectionInfo() returns null for 404', async () => {
    // Given
    const { client } = await createClient({
      collectionGetError: { code: 404 },
    })

    // When
    const info = await client.getCollectionInfo('osm_features')

    // Then
    expect(info).toBeNull()
  })

  test('ensureCollection() ignores 409 conflicts', async () => {
    // Given
    const { client, state } = await createClient({
      collectionCreateError: { code: 409 },
    })

    // When
    await client.ensureCollection('osm_features')

    // Then
    expect(state.collectionCreateCalls).toEqual(['osm_features'])
  })

  test('ensureGeoIndex() calls ensureIndex with geoJson enabled', async () => {
    // Given
    const { client, state } = await createClient()

    // When
    await client.ensureGeoIndex('osm_features', ['geometry'], true, 'geometry_geo')

    // Then
    expect(state.ensureIndexCalls).toHaveLength(1)
    expect(state.ensureIndexCalls[0]).toEqual({
      collection: 'osm_features',
      options: {
        type: 'geo',
        fields: ['geometry'],
        geoJson: true,
        name: 'geometry_geo',
      },
    })
  })

  test('importDocuments() passes onDuplicate when provided', async () => {
    // Given
    const { client, state } = await createClient({
      importResult: { created: 1 },
    })

    // When
    const res = await client.importDocuments('osm_features', [{ a: 1 }], { onDuplicate: 'update' })

    // Then
    expect(res.created).toBe(1)
    expect(state.importCalls).toHaveLength(1)
    expect(state.importCalls[0]).toEqual({
      collection: 'osm_features',
      docs: [{ a: 1 }],
      options: { onDuplicate: 'update' },
    })
  })

  test('wraps driver errors as ArangoApiError', async () => {
    // Given
    const err = new Error('boom')
    ;(err as any).code = 503
    ;(err as any).errorNum = 12345

    const { client } = await createClient({
      ensureIndexError: err,
    })

    // When
    const thrown = await catchError(() =>
      client.ensurePersistentIndex('osm_features', ['tagsKeys[*]'], true, 'tagsKeys_arr'),
    )

    // Then
    expect(thrown).toBeInstanceOf(ArangoApiError)
    expect(thrown.message).toBe('boom')
    expect((thrown as ArangoApiError).status).toBe(503)
    expect((thrown as ArangoApiError).errorNum).toBe(12345)
  })
})

interface FakeState {
  createDatabaseCalls: string[]
  collectionCreateCalls: string[]
  ensureIndexCalls: Array<{ collection: string, options: unknown }>
  importCalls: Array<{ collection: string, docs: object[], options: unknown }>
  createDatabaseError?: unknown
  collectionCreateError?: unknown
  collectionGetError?: unknown
  ensureIndexError?: unknown
  importResult?: unknown
}

async function createClient(overrides?: Partial<FakeState>) {
  const state: FakeState = {
    createDatabaseCalls: [],
    collectionCreateCalls: [],
    ensureIndexCalls: [],
    importCalls: [],
    ...overrides,
  }

  class FakeDatabase {
    constructor(_opts: unknown) {}

    async createDatabase(name: string): Promise<void> {
      state.createDatabaseCalls.push(name)
      if (state.createDatabaseError)
        throw state.createDatabaseError
    }

    collection(name: string) {
      return {
        create: async (): Promise<void> => {
          state.collectionCreateCalls.push(name)
          if (state.collectionCreateError)
            throw state.collectionCreateError
        },
        get: async (): Promise<unknown> => {
          if (state.collectionGetError)
            throw state.collectionGetError
          return { name }
        },
        ensureIndex: async (options: unknown): Promise<void> => {
          state.ensureIndexCalls.push({ collection: name, options })
          if (state.ensureIndexError)
            throw state.ensureIndexError
        },
        import: async (docs: object[], options?: unknown): Promise<unknown> => {
          state.importCalls.push({ collection: name, docs, options })
          return state.importResult ?? { created: docs.length }
        },
      }
    }
  }

  const client = await createArangoClient(
    { url: 'http://127.0.0.1:8529', database: 'osm', username: 'root', password: 'pw' },
    { Database: FakeDatabase as any },
  )

  return { client, state }
}

async function catchError<T>(fn: () => Promise<T>): Promise<Error> {
  try {
    await fn()
    throw new Error('Expected function to throw')
  }
  catch (err) {
    if (err instanceof Error)
      return err
    throw new Error(`Expected Error, got: ${String(err)}`)
  }
}
