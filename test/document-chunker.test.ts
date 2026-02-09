import { describe, expect, test } from 'bun:test'
import { createDocumentChunker } from '../src/util/document-chunker.ts'

describe('createDocumentChunker()', () => {
  test('flushes when exceeding maxBytes', () => {
    // Given
    const chunker = createDocumentChunker<{ a: number }>(10)

    // When
    const c1 = chunker.push({ a: 1 })
    const c2 = chunker.push({ a: 2 })
    const c3 = chunker.flush()

    // Then
    expect(c1).toBeUndefined()
    expect(Array.isArray(c2)).toBe(true)
    expect(Array.isArray(c3)).toBe(true)
  })

  test('uses estimatedBytes when provided', () => {
    // Given
    const chunker = createDocumentChunker<{ a: number }>(10)

    // When
    const c1 = chunker.push({ a: 1 }, 9)
    const c2 = chunker.push({ a: 2 }, 9)
    const c3 = chunker.flush()

    // Then
    expect(c1).toBeUndefined()
    expect(c2).toEqual([{ a: 1 }])
    expect(c3).toEqual([{ a: 2 }])
  })
})
