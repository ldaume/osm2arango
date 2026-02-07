import { describe, expect, test } from 'bun:test'
import { parseArgs } from '../src/cli/args.ts'

describe('parseArgs()', () => {
  test('parses positionals + boolean flags', () => {
    // Given
    const argv = ['bootstrap', '--help', 'x']

    // When
    const parsed = parseArgs(argv)

    // Then
    expect(parsed.positionals).toEqual(['bootstrap', 'x'])
    expect(parsed.flags.help).toBe(true)
  })

  test('parses --key=value', () => {
    // Given
    const argv = ['import', '--chunk-mb=16', 'file.ndjson']

    // When
    const parsed = parseArgs(argv)

    // Then
    expect(parsed.positionals).toEqual(['import', 'file.ndjson'])
    expect(parsed.flags['chunk-mb']).toBe('16')
  })

  test('parses --key value', () => {
    // Given
    const argv = ['download', '--out-dir', 'data', 'europe/germany/berlin']

    // When
    const parsed = parseArgs(argv)

    // Then
    expect(parsed.flags['out-dir']).toBe('data')
    expect(parsed.positionals).toEqual(['download', 'europe/germany/berlin'])
  })

  test('treats -h as --help', () => {
    // Given
    const argv = ['-h']

    // When
    const parsed = parseArgs(argv)

    // Then
    expect(parsed.flags.help).toBe(true)
  })

  test('treats -- as end of flags', () => {
    // Given
    const argv = ['import', '--chunk-mb', '16', '--', '--not-a-flag']

    // When
    const parsed = parseArgs(argv)

    // Then
    expect(parsed.flags['chunk-mb']).toBe('16')
    expect(parsed.positionals).toEqual(['import', '--not-a-flag'])
  })

  test('sets bare flags to true when no value is provided', () => {
    // Given
    const argv = ['import', '--dry-run']

    // When
    const parsed = parseArgs(argv)

    // Then
    expect(parsed.flags['dry-run']).toBe(true)
    expect(parsed.positionals).toEqual(['import'])
  })

  test('ignores undefined argv entries', () => {
    // Given
    const argv = ['bootstrap'] as string[]
    argv.length = 2

    // When
    const parsed = parseArgs(argv)

    // Then
    expect(parsed.positionals).toEqual(['bootstrap'])
  })
})
