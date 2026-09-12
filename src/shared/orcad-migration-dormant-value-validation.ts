export const MAX_ORCAD_MIGRATION_DORMANT_ROWS = 16_384
export const MAX_ORCAD_MIGRATION_DORMANT_NAMESPACES = 256

export function boundedArray<T>(
  value: unknown,
  parse: (entry: unknown) => T,
  label: string,
  maximum = MAX_ORCAD_MIGRATION_DORMANT_ROWS
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`orcad_migration_dormant_${label}_invalid`)
  }
  if (value.length > maximum) {
    throw new Error(`orcad_migration_dormant_${label}_too_many`)
  }
  return value.map(parse)
}

export function stringArray(value: unknown, maximum = MAX_ORCAD_MIGRATION_DORMANT_ROWS): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every(isString)) {
    throw new Error('orcad_migration_dormant_string_array_invalid')
  }
  const result = value.map((entry) => entry as string)
  if (result.some((entry) => !entry) || new Set(result).size !== result.length) {
    throw new Error('orcad_migration_dormant_string_array_invalid')
  }
  return result
}

export function assertUnique<T>(values: T[], key: (value: T) => string, label: string): void {
  const keys = values.map(key)
  if (new Set(keys).size !== keys.length) {
    throw new Error(`orcad_migration_dormant_${label}_duplicate`)
  }
}

export function requiredRecord(value: unknown, error: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(error)
  }
  return value as Record<string, unknown>
}

export function requiredString(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(error)
  }
  return value
}

export function requiredStringOrEmpty(value: unknown, error: string): string {
  if (typeof value !== 'string') {
    throw new Error(error)
  }
  return value
}

export function optionalNullableString(value: unknown, error: string): string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(error)
  }
  return value
}

export function requiredBoolean(value: unknown, error: string): void {
  if (typeof value !== 'boolean') {
    throw new Error(error)
  }
}

export function requiredFinite(value: unknown, error: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(error)
  }
}

export function optionalFinite(value: unknown, error: string, nullable = false): void {
  if (value === undefined || (nullable && value === null)) {
    return
  }
  requiredFinite(value, error)
}

export function optionalPositiveInteger(value: unknown, error: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1)) {
    throw new Error(error)
  }
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}
