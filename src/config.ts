import type { CliFlagValue } from './cli/args.ts'

export interface ArangoConnectionConfig {
  url: string
  database: string
  username: string
  password: string
}

export function resolveArangoConnectionConfig(
  env: Record<string, string | undefined>,
  flags: Record<string, CliFlagValue>,
): ArangoConnectionConfig {
  const url = readStringFlag(flags, 'arango-url') ?? env.ARANGO_URL ?? 'http://127.0.0.1:8529'
  const database = readStringFlag(flags, 'arango-db') ?? env.ARANGO_DB ?? ''
  const username = readStringFlag(flags, 'arango-user') ?? env.ARANGO_USER ?? 'root'
  const password = readStringFlag(flags, 'arango-pass') ?? env.ARANGO_PASS ?? ''

  if (!database) {
    throw new Error('Missing ArangoDB database. Set ARANGO_DB or pass --arango-db.')
  }
  if (!password) {
    throw new Error('Missing ArangoDB password. Set ARANGO_PASS or pass --arango-pass.')
  }

  return { url, database, username, password }
}

function readStringFlag(flags: Record<string, CliFlagValue>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

export function readStringFlagWithDefault(
  flags: Record<string, CliFlagValue>,
  key: string,
  defaultValue: string,
): string {
  return readStringFlag(flags, key) ?? defaultValue
}

export function readNumberFlagWithDefault(
  flags: Record<string, CliFlagValue>,
  key: string,
  defaultValue: number,
): number {
  const raw = readStringFlag(flags, key)
  if (raw === undefined)
    return defaultValue
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --${key} value: ${raw}`)
  }
  return n
}
