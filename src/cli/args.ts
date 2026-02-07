export type CliFlagValue = string | boolean

export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, CliFlagValue>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, CliFlagValue> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined)
      continue

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }

    if (arg === '-h') {
      flags.help = true
      continue
    }

    if (arg.startsWith('--')) {
      const raw = arg.slice(2)
      const eqIdx = raw.indexOf('=')
      const key = eqIdx === -1 ? raw : raw.slice(0, eqIdx)
      const inlineValue = eqIdx === -1 ? undefined : raw.slice(eqIdx + 1)

      // Some flags are always boolean and must not consume the next argument.
      if (key === 'help') {
        flags.help = true
        continue
      }

      if (inlineValue !== undefined) {
        flags[key] = inlineValue
        continue
      }

      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        i++
        continue
      }

      flags[key] = true
      continue
    }

    positionals.push(arg)
  }

  return { positionals, flags }
}
