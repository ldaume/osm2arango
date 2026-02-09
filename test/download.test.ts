import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { downloadGeofabrikExtract } from '../src/domain/download.ts'

describe('downloadGeofabrikExtract()', () => {
  test('downloads to outDir using an injected fetch', async () => {
    // Given
    const outDir = await mkdtemp(join(tmpdir(), 'osm2arango-download-'))
    const baseUrl = 'https://example.invalid'

    try {
      // When
      const result = await downloadGeofabrikExtract(
        'europe/germany/berlin',
        { baseUrl, outDir },
        {
          fetch: async (input) => {
            const url = String(input)
            expect(url).toBe(`${baseUrl}/europe/germany/berlin-latest.osm.pbf`)
            return new Response('pbf-bytes', { status: 200 })
          },
        },
      )

      // Then
      expect(result.url).toBe(`${baseUrl}/europe/germany/berlin-latest.osm.pbf`)
      expect(result.path).toBe(`${outDir}/berlin-latest.osm.pbf`)
      expect(await Bun.file(result.path).text()).toBe('pbf-bytes')
      expect(await readdir(outDir)).toEqual(['berlin-latest.osm.pbf'])
    }
    finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  test('throws for non-ok responses', async () => {
    // Given
    const outDir = await mkdtemp(join(tmpdir(), 'osm2arango-download-'))
    const baseUrl = 'https://example.invalid'

    try {
      // When
      const err = await catchError(() =>
        downloadGeofabrikExtract(
          'europe/germany/berlin',
          { baseUrl, outDir },
          {
            fetch: async () => new Response('not found', { status: 404 }),
          },
        ),
      )

      // Then
      expect(err.message).toContain('Download failed (404)')
    }
    finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})

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
