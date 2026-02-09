import { describe, expect, test } from 'bun:test'
import { readLines } from '../src/util/lines.ts'

describe('readLines()', () => {
  test('yields lines split by newline (including a final partial line)', async () => {
    // Given
    const stream = new Response('a\nb').body
    if (!stream)
      throw new Error('expected body stream')

    // When
    const lines: string[] = []
    for await (const line of readLines(stream)) {
      lines.push(line)
    }

    // Then
    expect(lines).toEqual(['a', 'b'])
  })

  test('does not yield an extra empty line for trailing newline', async () => {
    // Given
    const stream = new Response('a\n').body
    if (!stream)
      throw new Error('expected body stream')

    // When
    const lines: string[] = []
    for await (const line of readLines(stream)) {
      lines.push(line)
    }

    // Then
    expect(lines).toEqual(['a'])
  })

  test('can skip lines exceeding maxLineBytes', async () => {
    // Given
    const stream = new Response('abcd\nef').body
    if (!stream)
      throw new Error('expected body stream')

    const skipped: { bytes: number, maxLineBytes: number }[] = []

    // When
    const lines: string[] = []
    for await (const line of readLines(stream, {
      maxLineBytes: 3,
      tooLongLine: 'skip',
      onTooLongLine: info => skipped.push(info),
    })) {
      lines.push(line)
    }

    // Then
    expect(lines).toEqual(['ef'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.maxLineBytes).toBe(3)
    expect((skipped[0]?.bytes ?? 0) >= 4).toBe(true)
  })

  test('can avoid yielding a final partial line', async () => {
    // Given
    const stream = new Response('a\nb').body
    if (!stream)
      throw new Error('expected body stream')

    const partial: { bytes: number }[] = []

    // When
    const lines: string[] = []
    for await (const line of readLines(stream, {
      flushFinalPartialLine: false,
      onFinalPartialLine: info => partial.push(info),
    })) {
      lines.push(line)
    }

    // Then
    expect(lines).toEqual(['a'])
    expect(partial).toEqual([{ bytes: 1 }])
  })
})
