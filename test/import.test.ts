import type { ArangoClient } from '../src/arango/arango.data.ts'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { importOsm } from '../src/domain/import.ts'

describe('importOsm()', () => {
  test('skips unsupported geometry types by default and reports counts', async () => {
    // Given
    const { inputPath, cleanup } = await writeNdjson([
      geojsonFeaturePoint('n1'),
      geojsonFeatureGeometryCollection('r1'),
    ])

    const importedDocs: object[] = []
    const arangoClient = createStubArangoClient({
      importDocuments: async (_collection, docs) => {
        importedDocs.push(...docs)
        return { created: docs.length, updated: 0, ignored: 0, empty: 0, errors: 0 }
      },
    })

    try {
      // When
      const summary = await importOsm(
        { url: 'http://127.0.0.1:8529', database: 'osm', username: 'root', password: 'pw' },
        inputPath,
        {
          collection: 'osm_features',
          adapter: 'ndjson',
          chunkBytes: 1024 * 1024,
          concurrency: 1,
          onDuplicate: 'update',
        },
        {
          createArangoClient: async () => arangoClient,
        },
      )

      // Then
      expect(summary.seen).toBe(2)
      expect(summary.created).toBe(1)
      expect(summary.skippedUnsupportedGeometry).toBe(1)
      expect(summary.geometryTypeCounts.Point).toBe(1)
      expect(summary.geometryTypeCounts.GeometryCollection).toBe(1)
      expect(summary.unsupportedGeometryTypeCounts.GeometryCollection).toBe(1)
      expect(importedDocs).toHaveLength(1)
    }
    finally {
      await cleanup()
    }
  })

  test('can keep unsupported geometry types', async () => {
    // Given
    const { inputPath, cleanup } = await writeNdjson([
      geojsonFeaturePoint('n1'),
      geojsonFeatureGeometryCollection('r1'),
    ])

    const importedDocs: object[] = []
    const arangoClient = createStubArangoClient({
      importDocuments: async (_collection, docs) => {
        importedDocs.push(...docs)
        return { created: docs.length, updated: 0, ignored: 0, empty: 0, errors: 0 }
      },
    })

    try {
      // When
      const summary = await importOsm(
        { url: 'http://127.0.0.1:8529', database: 'osm', username: 'root', password: 'pw' },
        inputPath,
        {
          collection: 'osm_features',
          adapter: 'ndjson',
          chunkBytes: 1024 * 1024,
          concurrency: 1,
          onDuplicate: 'update',
          unsupportedGeometry: 'keep',
        },
        {
          createArangoClient: async () => arangoClient,
        },
      )

      // Then
      expect(summary.seen).toBe(2)
      expect(summary.created).toBe(2)
      expect(summary.skippedUnsupportedGeometry).toBe(0)
      expect(summary.unsupportedGeometryTypeCounts.GeometryCollection).toBe(1)
      expect(importedDocs).toHaveLength(2)
    }
    finally {
      await cleanup()
    }
  })

  test('can fail fast on unsupported geometry types', async () => {
    // Given
    const { inputPath, cleanup } = await writeNdjson([
      geojsonFeaturePoint('n1'),
      geojsonFeatureGeometryCollection('r1'),
    ])

    let importCalls = 0
    const arangoClient = createStubArangoClient({
      importDocuments: async (_collection, docs) => {
        importCalls++
        return { created: docs.length, updated: 0, ignored: 0, empty: 0, errors: 0 }
      },
    })

    try {
      // When
      const err = await catchError(() =>
        importOsm(
          { url: 'http://127.0.0.1:8529', database: 'osm', username: 'root', password: 'pw' },
          inputPath,
          {
            collection: 'osm_features',
            adapter: 'ndjson',
            chunkBytes: 1024 * 1024,
            concurrency: 1,
            onDuplicate: 'update',
            unsupportedGeometry: 'error',
          },
          {
            createArangoClient: async () => arangoClient,
          },
        ),
      )

      // Then
      expect(err.message).toContain('Unsupported GeoJSON geometry type: GeometryCollection')
      expect(importCalls).toBe(0)
    }
    finally {
      await cleanup()
    }
  })

  test('rejects NDJSON documents without geometry.type', async () => {
    // Given
    const { inputPath, cleanup } = await writeNdjson([
      {
        _key: 'x',
        geometry: {},
        tags: {},
        tagsKeys: [],
        tagsKV: [],
        osm: {},
      },
    ])

    const arangoClient = createStubArangoClient({
      importDocuments: async (_collection, docs) => {
        return { created: docs.length, updated: 0, ignored: 0, empty: 0, errors: 0 }
      },
    })

    try {
      // When
      const err = await catchError(() =>
        importOsm(
          { url: 'http://127.0.0.1:8529', database: 'osm', username: 'root', password: 'pw' },
          inputPath,
          {
            collection: 'osm_features',
            adapter: 'ndjson',
            chunkBytes: 1024 * 1024,
            concurrency: 1,
            onDuplicate: 'update',
          },
          {
            createArangoClient: async () => arangoClient,
          },
        ),
      )

      // Then
      expect(err.message).toBe('NDJSON document geometry.type must be a non-empty string')
    }
    finally {
      await cleanup()
    }
  })
})

function createStubArangoClient(overrides: Partial<ArangoClient>): ArangoClient {
  return {
    ensureDatabase: async () => {},
    ensureCollection: async () => {},
    getCollectionInfo: async name => ({ name }),
    ensureGeoIndex: async () => {},
    ensurePersistentIndex: async () => {},
    importDocuments: async () => ({ created: 0, errors: 0 }),
    ...overrides,
  }
}

async function writeNdjson(lines: unknown[]): Promise<{ inputPath: string, cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'osm2arango-import-'))
  const inputPath = join(dir, 'input.ndjson')
  const content = `${lines.map(l => JSON.stringify(l)).join('\n')}\n`
  await Bun.write(inputPath, content)
  return {
    inputPath,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  }
}

function geojsonFeaturePoint(id: string): unknown {
  return {
    type: 'Feature',
    id,
    properties: { type: 'node', id: 1, tags: [{ k: 'amenity', v: 'cafe' }] },
    geometry: { type: 'Point', coordinates: [13.4, 52.5] },
  }
}

function geojsonFeatureGeometryCollection(id: string): unknown {
  return {
    type: 'Feature',
    id,
    properties: { type: 'relation', id: 1, tags: [{ k: 'amenity', v: 'school' }] },
    geometry: { type: 'GeometryCollection', geometries: [] },
  }
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
