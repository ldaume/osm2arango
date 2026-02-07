import type { ArangoConnectionConfig } from '../config.ts'
import { createArangoClient as createArangoClientLive } from '../arango/arango.data.ts'

export interface BootstrapOptions {
  collection: string
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

  // System DB is needed for database creation.
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

  // GeoJSON geo index for geometry. This is the critical index for later aggregation workloads.
  // Note: for index-backed AQL filters with GEO_* utility functions, pass `doc.geometry` as the 2nd argument.
  await dbClient.ensureGeoIndex(opts.collection, ['geometry'], true, 'geometry_geo')

  // Tag lookup: array indexes for (key) and (key=value). Keeps tag schema stable.
  await dbClient.ensurePersistentIndex(opts.collection, ['tagsKeys[*]'], true, 'tagsKeys_arr')
  await dbClient.ensurePersistentIndex(opts.collection, ['tagsKV[*]'], true, 'tagsKV_arr')
}
