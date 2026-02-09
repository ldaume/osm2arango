import type { Database as ArangojsDatabase } from 'arangojs'
import type { NodeHttpRequestFn } from '../src/arango/arango.data.ts'

import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'

import { createArangoClient } from '../src/arango/arango.data.ts'

describe('Arango import transport', () => {
  test('imports documents via node:http transport (no network; request is stubbed)', async () => {
    // Given
    const docs = [
      { _key: 'a1', x: 1 },
      { _key: 'a2', x: 2 },
    ]

    const expectedAuth = `Basic ${Buffer.from('root:pw', 'utf8').toString('base64')}`

    let received:
      | {
        options: unknown
        body: string
      }
      | undefined

    const httpRequestStub: NodeHttpRequestFn = ((options: unknown, cb: (res: FakeIncomingMessage) => void) => {
      class FakeClientRequest extends EventEmitter {
        end(body: string): void {
          received = { options, body }
          const res = new FakeIncomingMessage(201)
          cb(res)
          res.emit('data', Buffer.from(JSON.stringify({ created: 2, updated: 0, ignored: 0, empty: 0, errors: 0 })))
          res.emit('end')
        }
      }

      return new FakeClientRequest() as unknown as ReturnType<NodeHttpRequestFn>
    }) as unknown as NodeHttpRequestFn

    class FakeDatabase {
      constructor(_opts: unknown) {}
      async createDatabase(_name: string): Promise<void> {}
      collection(name: string): unknown {
        return {
          create: async (): Promise<void> => {},
          get: async () => ({ name, status: 3, type: 2 }),
          ensureIndex: async (): Promise<void> => {},
          import: async () => ({ created: 0, errors: 0 }),
        }
      }
    }

    const client = await createArangoClient({
      url: 'http://127.0.0.1:8529',
      database: 'osm',
      username: 'root',
      password: 'pw',
      importTransport: 'node-http',
    }, {
      Database: FakeDatabase as unknown as typeof ArangojsDatabase,
      httpRequest: httpRequestStub,
    })

    // When
    const result = await client.importDocuments('osm_features', docs, { onDuplicate: 'update' })

    // Then
    expect(result).toEqual({ created: 2, updated: 0, ignored: 0, empty: 0, errors: 0 })

    if (!received)
      throw new Error('Expected request to be performed')

    const opt = received.options as Record<string, unknown>
    expect(opt.method).toBe('POST')
    expect(opt.path).toBe('/_db/osm/_api/import?collection=osm_features&type=documents&onDuplicate=update')

    const headers = opt.headers as Record<string, unknown>
    expect(headers.authorization).toBe(expectedAuth)
    expect(headers.accept).toBe('application/json')
    expect(headers['content-type']).toBe('application/x-ldjson')

    // One JSON document per line, trailing newline.
    expect(received.body.endsWith('\n')).toBe(true)
    const lines = received.body.split('\n').filter(Boolean)
    expect(lines).toHaveLength(docs.length)
    expect(lines.map(l => JSON.parse(l))).toEqual(docs)

    // Content-Length must match the payload.
    expect(headers['content-length']).toBe(String(Buffer.byteLength(received.body, 'utf8')))
  })

  test('imports documents via curl transport (no network; spawn is stubbed)', async () => {
    // Given
    const docs = [
      { _key: 'a1', x: 1 },
      { _key: 'a2', x: 2 },
    ]

    const expectedAuth = `Basic ${Buffer.from('root:pw', 'utf8').toString('base64')}`
    const expectedUrl = 'http://127.0.0.1:8529/_db/osm/_api/import?collection=osm_features&type=documents&onDuplicate=update'
    const expectedBody = `${docs.map(d => JSON.stringify(d)).join('\n')}\n`
    const expectedBodyBytes = Buffer.from(expectedBody, 'utf8')

    let received:
      | {
        cmd: string[]
        stdin: unknown
      }
      | undefined

    const spawnStub = ((cmd: string[], opts: { stdin?: unknown }) => {
      received = { cmd, stdin: opts.stdin }
      return {
        exited: Promise.resolve(0),
        stdout: streamFromText(`${JSON.stringify({ created: 2, updated: 0, ignored: 0, empty: 0, errors: 0 })}\n201`),
        stderr: streamFromText(''),
      }
    }) as unknown as typeof Bun.spawn

    class FakeDatabase {
      constructor(_opts: unknown) {}
      async createDatabase(_name: string): Promise<void> {}
      collection(name: string): unknown {
        return {
          create: async (): Promise<void> => {},
          get: async () => ({ name, status: 3, type: 2 }),
          ensureIndex: async (): Promise<void> => {},
          import: async () => ({ created: 0, errors: 0 }),
        }
      }
    }

    const client = await createArangoClient({
      url: 'http://127.0.0.1:8529',
      database: 'osm',
      username: 'root',
      password: 'pw',
      importTransport: 'curl',
    }, {
      Database: FakeDatabase as unknown as typeof ArangojsDatabase,
      spawn: spawnStub,
    })

    // When
    const result = await client.importDocuments('osm_features', docs, { onDuplicate: 'update' })

    // Then
    expect(result).toEqual({ created: 2, updated: 0, ignored: 0, empty: 0, errors: 0 })

    if (!received)
      throw new Error('Expected curl to be spawned')

    expect(received.cmd[0]).toBe('curl')
    expect(received.cmd).toContain(expectedUrl)
    expect(received.cmd).toContain(`authorization: Basic ${expectedAuth.slice('Basic '.length)}`)
    expect(received.cmd).toContain('accept: application/json')
    expect(received.cmd).toContain('content-type: application/x-ldjson')
    expect(received.stdin).toEqual(expectedBodyBytes)
  })
})

class FakeIncomingMessage extends EventEmitter {
  statusCode: number
  constructor(statusCode: number) {
    super()
    this.statusCode = statusCode
  }
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
