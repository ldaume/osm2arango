import type { ArangoConnectionConfig } from '../config.ts'
import { createArangoClient as createArangoClientLive } from '../arango/arango.data.ts'

export interface BootstrapOptions {
  collection: string
  indexes?: 'all' | 'none' | 'geo' | 'tags'
}

export interface BootstrapDeps {
  createArangoClient?: typeof createArangoClientLive
}

export async function bootstrapArango(
  conn: ArangoConnectionConfig,
  opts: BootstrapOptions,
  deps?: BootstrapDeps,
): Promise<void> {
  const createClient = deps?.createArangoClient ?? createArangoClientLive

  // Databases can only be created via _system.
  const systemClient = await createClient({
    url: conn.url,
    database: '_system',
    username: conn.username,
    password: conn.password,
  })
  await systemClient.ensureDatabase(conn.database)

  const dbClient = await createClient({
    url: conn.url,
    database: conn.database,
    username: conn.username,
    password: conn.password,
  })

  await dbClient.ensureCollection(opts.collection)

  const indexes = opts.indexes ?? 'all'
  if (indexes === 'none')
    return

  if (indexes === 'geo' || indexes === 'all') {
    // GeoJSON index on `geometry` for GEO_* utility functions.
    await dbClient.ensureGeoIndex(opts.collection, ['geometry'], true, 'geometry_geo')
  }

  if (indexes === 'tags' || indexes === 'all') {
    // Array indexes for tag lookups by key and key=value.
    await dbClient.ensurePersistentIndex(opts.collection, ['tagsKeys[*]'], true, 'tagsKeys_arr')
    await dbClient.ensurePersistentIndex(opts.collection, ['tagsKV[*]'], true, 'tagsKV_arr')
  }
}
