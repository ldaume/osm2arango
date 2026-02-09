import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Database as ArangojsDatabase } from 'arangojs'

export type NodeHttpRequestFn = typeof httpRequest
export type NodeHttpsRequestFn = typeof httpsRequest

export interface ArangoConnection {
  url: string
  database: string
  username: string
  password: string
  importTransport?: ArangoImportTransport
}

export type ArangoImportTransport = 'arangojs' | 'node-http' | 'curl'

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
  httpRequest?: NodeHttpRequestFn
  httpsRequest?: NodeHttpsRequestFn
  spawn?: typeof Bun.spawn
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
      if (conn.importTransport === 'node-http') {
        const req = {
          ...(deps?.httpRequest ? { httpRequest: deps.httpRequest } : {}),
          ...(deps?.httpsRequest ? { httpsRequest: deps.httpsRequest } : {}),
        }
        return await importDocumentsViaNodeHttp(conn, collection, docs, opts, req)
      }

      if (conn.importTransport === 'curl') {
        return await importDocumentsViaCurl(conn, collection, docs, opts, deps?.spawn)
      }

      // Bulk import; the caller must bound chunk size.
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

async function importDocumentsViaCurl(
  conn: ArangoConnection,
  collection: string,
  docs: object[],
  opts?: ArangoImportOptions,
  spawnFn?: typeof Bun.spawn,
): Promise<ArangoImportResult> {
  const baseUrl = new URL(conn.url)
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error(`Unsupported ArangoDB URL protocol: ${baseUrl.protocol}`)
  }

  const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname
  const pathname = `${basePath}/_db/${encodeURIComponent(conn.database)}/_api/import`

  const searchParams = new URLSearchParams()
  searchParams.set('collection', collection)
  searchParams.set('type', 'documents')
  if (opts?.onDuplicate) {
    searchParams.set('onDuplicate', opts.onDuplicate)
  }

  const url = `${baseUrl.origin}${pathname}?${searchParams.toString()}`

  const auth = Buffer.from(`${conn.username}:${conn.password}`, 'utf8').toString('base64')

  const body = `${docs.map(d => JSON.stringify(d)).join('\n')}\n`
  const bodyBytes = Buffer.from(body, 'utf8')

  const spawn0 = spawnFn ?? Bun.spawn
  const proc = spawn0(
    [
      'curl',
      '-sS',
      '-X',
      'POST',
      url,
      '-H',
      `authorization: Basic ${auth}`,
      '-H',
      'accept: application/json',
      '-H',
      'content-type: application/x-ldjson',
      '--data-binary',
      '@-',
      '-w',
      '\n%{http_code}',
    ],
    {
      stdin: bodyBytes,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
  ])

  if (exitCode !== 0) {
    const extra = stderrText.trim() ? `\n${stderrText.trim()}` : ''
    throw new Error(`curl import failed (exitCode=${exitCode}).${extra}`)
  }

  const nl = stdoutText.lastIndexOf('\n')
  if (nl < 0) {
    throw new Error('Unexpected curl output (missing status code trailer)')
  }

  const statusStr = stdoutText.slice(nl + 1).trim()
  const status = Number(statusStr)
  if (!Number.isFinite(status) || status <= 0) {
    throw new Error(`Unexpected curl HTTP status: ${statusStr}`)
  }

  const responseBody = stdoutText.slice(0, nl).trim()

  if (status < 200 || status >= 300) {
    let message = responseBody
    let errorNum: number | undefined

    try {
      const parsed = JSON.parse(responseBody) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Record<string, unknown>
        if (typeof p.errorMessage === 'string')
          message = p.errorMessage
        if (typeof p.errorNum === 'number')
          errorNum = p.errorNum
      }
    }
    catch {
      // Keep raw body as message.
    }

    throw new ArangoApiError(message || 'ArangoDB import failed', status, errorNum)
  }

  try {
    return JSON.parse(responseBody) as ArangoImportResult
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse ArangoDB import response: ${msg}`)
  }
}

async function importDocumentsViaNodeHttp(
  conn: ArangoConnection,
  collection: string,
  docs: object[],
  opts?: ArangoImportOptions,
  req?: { httpRequest?: NodeHttpRequestFn, httpsRequest?: NodeHttpsRequestFn },
): Promise<ArangoImportResult> {
  const baseUrl = new URL(conn.url)
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error(`Unsupported ArangoDB URL protocol: ${baseUrl.protocol}`)
  }

  const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname
  const pathname = `${basePath}/_db/${encodeURIComponent(conn.database)}/_api/import`

  const searchParams = new URLSearchParams()
  searchParams.set('collection', collection)
  searchParams.set('type', 'documents')
  if (opts?.onDuplicate) {
    searchParams.set('onDuplicate', opts.onDuplicate)
  }

  const body = `${docs.map(d => JSON.stringify(d)).join('\n')}\n`
  const contentLength = Buffer.byteLength(body, 'utf8')

  const auth = Buffer.from(`${conn.username}:${conn.password}`, 'utf8').toString('base64')

  const port = baseUrl.port
    ? Number(baseUrl.port)
    : baseUrl.protocol === 'https:'
      ? 443
      : 80

  const requestFn = baseUrl.protocol === 'https:'
    ? (req?.httpsRequest ?? httpsRequest)
    : (req?.httpRequest ?? httpRequest)

  const res = await new Promise<{ statusCode: number, body: string }>((resolve, reject) => {
    const req = requestFn({
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      port,
      method: 'POST',
      path: `${pathname}?${searchParams.toString()}`,
      // Disable connection pooling for stability; import is throughput bound anyway.
      agent: false,
      headers: {
        'authorization': `Basic ${auth}`,
        'accept': 'application/json',
        'content-type': 'application/x-ldjson',
        'content-length': String(contentLength),
      },
    }, (r) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ statusCode: r.statusCode ?? 0, body: text })
      })
    })

    req.on('error', reject)
    req.end(body)
  })

  if (res.statusCode < 200 || res.statusCode >= 300) {
    let message = res.body
    let errorNum: number | undefined

    try {
      const parsed = JSON.parse(res.body) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Record<string, unknown>
        if (typeof p.errorMessage === 'string')
          message = p.errorMessage
        if (typeof p.errorNum === 'number')
          errorNum = p.errorNum
      }
    }
    catch {
      // Keep raw body as message.
    }

    throw new ArangoApiError(message || 'ArangoDB import failed', res.statusCode, errorNum)
  }

  try {
    return JSON.parse(res.body) as ArangoImportResult
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse ArangoDB import response: ${msg}`)
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
