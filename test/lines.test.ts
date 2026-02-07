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
})
