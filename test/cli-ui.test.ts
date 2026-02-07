import { describe, expect, test } from 'bun:test'
import { formatDurationMs } from '../src/cli/ui.ts'

describe('formatDurationMs()', () => {
  test('formats sub-second durations in ms', () => {
    // Given / When / Then
    expect(formatDurationMs(1)).toBe('1ms')
    expect(formatDurationMs(999)).toBe('999ms')
  })

  test('formats short durations in seconds (1 decimal under 10s)', () => {
    // Given / When / Then
    expect(formatDurationMs(1000)).toBe('1.0s')
    expect(formatDurationMs(3200)).toBe('3.2s')
    expect(formatDurationMs(9999)).toBe('10.0s')
  })

  test('formats minute and hour durations', () => {
    // Given / When / Then
    expect(formatDurationMs(10_000)).toBe('10s')
    expect(formatDurationMs(61_000)).toBe('1m 01s')
    expect(formatDurationMs(3_661_000)).toBe('1h 01m 01s')
  })

  test('formats day durations', () => {
    // Given / When / Then
    expect(formatDurationMs(86_400_000)).toBe('1d 00h 00m 00s')
    expect(formatDurationMs(86_400_000 + 3_661_000)).toBe('1d 01h 01m 01s')
  })

  test('handles invalid input', () => {
    // Given / When / Then
    expect(formatDurationMs(0)).toBe('0s')
    expect(formatDurationMs(-5)).toBe('0s')
    expect(formatDurationMs(Number.NaN)).toBe('0s')
  })
})
