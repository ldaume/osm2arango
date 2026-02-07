import { describe, expect, test } from 'bun:test'
import { readNumberFlagWithDefault, readStringFlagWithDefault, resolveArangoConnectionConfig } from '../src/config.ts'

describe('resolveArangoConnectionConfig()', () => {
  test('uses defaults + env', () => {
    // Given
    const env = {
      ARANGO_DB: 'osm',
      ARANGO_PASS: 'secret',
    }

    // When
    const cfg = resolveArangoConnectionConfig(env, {})

    // Then
    expect(cfg.url).toBe('http://127.0.0.1:8529')
    expect(cfg.database).toBe('osm')
    expect(cfg.username).toBe('root')
    expect(cfg.password).toBe('secret')
  })

  test('flags override env', () => {
    // Given
    const env = {
      ARANGO_URL: 'http://127.0.0.1:8529',
      ARANGO_DB: 'env_db',
      ARANGO_USER: 'env_user',
      ARANGO_PASS: 'env_pass',
    }

    // When
    const cfg = resolveArangoConnectionConfig(env, {
      'arango-url': 'http://example:8529',
      'arango-db': 'flag_db',
      'arango-user': 'flag_user',
      'arango-pass': 'flag_pass',
    })

    // Then
    expect(cfg.url).toBe('http://example:8529')
    expect(cfg.database).toBe('flag_db')
    expect(cfg.username).toBe('flag_user')
    expect(cfg.password).toBe('flag_pass')
  })

  test('throws if database is missing', () => {
    // Given
    const env = { ARANGO_PASS: 'secret' }

    // When
    const err = catchError(() => resolveArangoConnectionConfig(env, {}))

    // Then
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Missing ArangoDB database')
  })

  test('throws if password is missing', () => {
    // Given
    const env = { ARANGO_DB: 'osm' }

    // When
    const err = catchError(() => resolveArangoConnectionConfig(env, {}))

    // Then
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Missing ArangoDB password')
  })
})

describe('readStringFlagWithDefault()', () => {
  test('returns default when missing', () => {
    // Given
    const flags = {}

    // When
    const v = readStringFlagWithDefault(flags, 'x', 'd')

    // Then
    expect(v).toBe('d')
  })

  test('returns flag value when present', () => {
    // Given
    const flags = { x: 'y' }

    // When
    const v = readStringFlagWithDefault(flags, 'x', 'd')

    // Then
    expect(v).toBe('y')
  })
})

describe('readNumberFlagWithDefault()', () => {
  test('returns default when missing', () => {
    // Given
    const flags = {}

    // When
    const v = readNumberFlagWithDefault(flags, 'n', 5)

    // Then
    expect(v).toBe(5)
  })

  test('parses positive numbers', () => {
    // Given
    const flags = { n: '10' }

    // When
    const v = readNumberFlagWithDefault(flags, 'n', 5)

    // Then
    expect(v).toBe(10)
  })

  test('rejects non-positive values', () => {
    // Given
    const flags = { n: '0' }

    // When / Then
    expect(() => readNumberFlagWithDefault(flags, 'n', 5)).toThrow('Invalid --n value: 0')
  })
})

function catchError(fn: () => unknown): Error {
  try {
    fn()
    throw new Error('Expected function to throw')
  }
  catch (err) {
    if (err instanceof Error)
      return err
    throw new Error(`Expected Error, got: ${String(err)}`)
  }
}
