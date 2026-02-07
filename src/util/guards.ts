export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

export function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
  return value
}

export function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`)
  }
  return value
}
