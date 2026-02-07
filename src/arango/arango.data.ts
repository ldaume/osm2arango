import { Database as ArangojsDatabase } from 'arangojs'

export interface ArangoConnection {
  url: string
  database: string
  username: string
  password: string
}

export interface ArangoImportOptions {
  onDuplicate?: 'error' | 'update' | 'replace' | 'ignore'
}

export interface ArangoImportResult {
  created?: number
  errors?: number
  empty?: number
  ignored?: number
  updated?: number
}

export interface ArangoCollectionInfo {
  name: string
  status?: number
  type?: number
}

export interface ArangoIndexInfo {
  id: string
  type: string
  fields: string[]
  name?: string
}

export class ArangoApiError extends Error {
  readonly status: number
  readonly errorNum: number | undefined

  constructor(message: string, status: number, errorNum?: number) {
    super(message)
    this.name = 'ArangoApiError'
    this.status = status
    this.errorNum = errorNum
  }
}

export interface ArangoClient {
  ensureDatabase: (name: string) => Promise<void>
  ensureCollection: (name: string) => Promise<void>
  getCollectionInfo: (name: string) => Promise<ArangoCollectionInfo | null>
  ensureGeoIndex: (
    collection: string,
    fields: [string],
    geoJson: boolean,
    name?: string,
  ) => Promise<void>
  ensurePersistentIndex: (collection: string, fields: string[], sparse: boolean, name?: string) => Promise<void>
  importDocuments: (
    collection: string,
    docs: object[],
    opts?: ArangoImportOptions,
  ) => Promise<ArangoImportResult>
}

export interface ArangoClientDeps {
  Database?: typeof ArangojsDatabase
}

export async function createArangoClient(conn: ArangoConnection, deps?: ArangoClientDeps): Promise<ArangoClient> {
  const Database = deps?.Database ?? ArangojsDatabase
  const db = new Database({
    url: conn.url,
    databaseName: conn.database,
    auth: { username: conn.username, password: conn.password },
  })

  const ensureDatabase = async (name: string): Promise<void> => {
    try {
      await db.createDatabase(name)
    }
    catch (err) {
      if (getStatusCode(err) === 409)
        return
      throw toArangoApiError(err, `Failed to create database: ${name}`)
    }
  }

  const ensureCollection = async (name: string): Promise<void> => {
    try {
      await db.collection(name).create()
    }
    catch (err) {
      if (getStatusCode(err) === 409)
        return
      throw toArangoApiError(err, `Failed to create collection: ${name}`)
    }
  }

  const getCollectionInfo = async (name: string): Promise<ArangoCollectionInfo | null> => {
    try {
      const res = await db.collection(name).get()
      return { name: res.name, status: res.status, type: res.type }
    }
    catch (err) {
      if (getStatusCode(err) === 404)
        return null
      throw toArangoApiError(err, `Failed to load collection info: ${name}`)
    }
  }

  const ensureGeoIndex = async (
    collection: string,
    fields: [string],
    geoJson: boolean,
    name?: string,
  ): Promise<void> => {
    try {
      const options = {
        type: 'geo' as const,
        fields,
        geoJson,
        ...(name ? { name } : {}),
      }
      await db.collection(collection).ensureIndex(options)
    }
    catch (err) {
      if (getStatusCode(err) === 409)
        return
      throw toArangoApiError(err, `Failed to create geo index on ${collection}`)
    }
  }

  const ensurePersistentIndex = async (
    collection: string,
    fields: string[],
    sparse: boolean,
    name?: string,
  ): Promise<void> => {
    try {
      const options = {
        type: 'persistent' as const,
        fields,
        sparse,
        unique: false,
        ...(name ? { name } : {}),
      }
      await db.collection(collection).ensureIndex(options)
    }
    catch (err) {
      if (getStatusCode(err) === 409)
        return
      throw toArangoApiError(err, `Failed to create persistent index on ${collection}`)
    }
  }

  const importDocuments = async (
    collection: string,
    docs: object[],
    opts?: ArangoImportOptions,
  ): Promise<ArangoImportResult> => {
    try {
      // Uses ArangoDB's bulk import endpoint under the hood. Keep chunks bounded in the caller.
      const options = opts?.onDuplicate ? { onDuplicate: opts.onDuplicate } : undefined
      return (await db.collection(collection).import(docs, options)) as ArangoImportResult
    }
    catch (err) {
      throw toArangoApiError(err, `Import failed for collection: ${collection}`)
    }
  }

  return {
    ensureDatabase,
    ensureCollection,
    getCollectionInfo,
    ensureGeoIndex,
    ensurePersistentIndex,
    importDocuments,
  }
}

function getStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null)
    return undefined
  const e = err as Record<string, unknown>

  if (typeof e.code === 'number')
    return e.code
  if (typeof e.status === 'number')
    return e.status

  const response = e.response
  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>
    if (typeof r.status === 'number')
      return r.status
    if (typeof r.statusCode === 'number')
      return r.statusCode
  }

  return undefined
}

function getErrorNum(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null)
    return undefined
  const e = err as Record<string, unknown>

  if (typeof e.errorNum === 'number')
    return e.errorNum

  const response = e.response
  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>
    const body = r.body
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>
      if (typeof b.errorNum === 'number')
        return b.errorNum
    }
  }

  return undefined
}

function toArangoApiError(err: unknown, fallbackMessage: string): ArangoApiError {
  const status = getStatusCode(err) ?? 500
  const errorNum = getErrorNum(err)
  const message = err instanceof Error ? err.message : fallbackMessage
  return new ArangoApiError(message, status, errorNum)
}
