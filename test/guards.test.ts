import { describe, expect, test } from 'bun:test'
import { asNumber, assertRecord, asString, isRecord } from '../src/util/guards.ts'

describe('guards', () => {
  test('isRecord()', () => {
    // Given
    const obj = { a: 1 }

    // When / Then
    expect(isRecord(obj)).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([1, 2, 3])).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  test('assertRecord()', () => {
    // Given
    const obj = { a: 1 }

    // When
    const result = assertRecord(obj, 'x')

    // Then
    expect(result).toBe(obj)
    expect(() => assertRecord(null, 'x')).toThrow('x must be an object')
  })

  test('asString()', () => {
    // Given
    const v: unknown = 'x'

    // When
    const s = asString(v, 'v')

    // Then
    expect(s).toBe('x')
    expect(() => asString(123, 'v')).toThrow(TypeError)
  })

  test('asNumber()', () => {
    // Given
    const v: unknown = 1

    // When
    const n = asNumber(v, 'v')

    // Then
    expect(n).toBe(1)
    expect(() => asNumber('1', 'v')).toThrow(TypeError)
    expect(() => asNumber(Number.NaN, 'v')).toThrow(TypeError)
  })
})
