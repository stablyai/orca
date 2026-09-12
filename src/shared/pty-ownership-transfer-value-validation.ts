export function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code)
  }
  return value as Record<string, unknown>
}

export function boundedString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(code)
  }
  return value
}

export function requirePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(code)
  }
  return Number(value)
}

export function requireSequence(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(code)
  }
  return Number(value)
}

export function requireDate(value: unknown, code: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(code)
  }
  return value
}

export function requirePhase<T extends string>(
  value: unknown,
  phases: readonly T[],
  code: string
): T {
  if (typeof value !== 'string' || !phases.includes(value as T)) {
    throw new Error(code)
  }
  return value as T
}
