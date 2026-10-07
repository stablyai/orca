import {
  assertUniqueKeys,
  boundedList,
  boundedStringArray,
  isRecord,
  nonEmptyString
} from './orcad-migration-manifest-fields'

export const MAX_ORCAD_MIGRATION_DORMANT_ROWS = 16_384
export const MAX_ORCAD_MIGRATION_DORMANT_NAMESPACES = 256

export function boundedArray<T>(
  value: unknown,
  parse: (entry: unknown) => T,
  label: string,
  maximum = MAX_ORCAD_MIGRATION_DORMANT_ROWS
): T[] {
  return boundedList(value, maximum, parse, `orcad_migration_dormant_${label}`)
}

export function stringArray(value: unknown, maximum = MAX_ORCAD_MIGRATION_DORMANT_ROWS): string[] {
  return boundedStringArray(value, maximum, 'orcad_migration_dormant_string_array_invalid')
}

export function assertUnique<T>(values: T[], key: (value: T) => string, label: string): void {
  assertUniqueKeys(values, key, `orcad_migration_dormant_${label}_duplicate`)
}

export function requiredRecord(value: unknown, error: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(error)
  }
  return value
}

export const requiredString = nonEmptyString

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
