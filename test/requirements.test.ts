import { describe, expect, test } from 'bun:test'
import { detectOsmiumInstallPlan } from '../src/cli/requirements.ts'

describe('detectOsmiumInstallPlan()', () => {
  test('darwin uses Homebrew when available', () => {
    // Given
    const which = whichStub(['brew'])

    // When
    const plan = detectOsmiumInstallPlan('darwin', which)

    // Then
    expect(plan?.name).toBe('Homebrew')
    expect(plan?.steps).toEqual([['brew', 'install', 'osmium-tool']])
  })

  test('linux uses apt-get when available', () => {
    // Given
    const which = whichStub(['apt-get'])

    // When
    const plan = detectOsmiumInstallPlan('linux', which)

    // Then
    expect(plan?.name).toBe('apt-get')
    expect(plan?.steps[0]).toEqual(['sudo', 'apt-get', 'update'])
  })

  test('linux uses pacman when available', () => {
    // Given
    const which = whichStub(['pacman'])

    // When
    const plan = detectOsmiumInstallPlan('linux', which)

    // Then
    expect(plan?.name).toBe('pacman')
    expect(plan?.steps).toEqual([['sudo', 'pacman', '-S', 'osmium-tool']])
  })

  test('returns undefined when no supported package manager exists', () => {
    // Given
    const which = whichStub([])

    // When
    const plan = detectOsmiumInstallPlan('linux', which)

    // Then
    expect(plan).toBeUndefined()
  })
})

function whichStub(commands: string[]): (cmd: string) => string | null {
  const set = new Set(commands)
  return (cmd: string) => set.has(cmd) ? `/usr/bin/${cmd}` : null
}
