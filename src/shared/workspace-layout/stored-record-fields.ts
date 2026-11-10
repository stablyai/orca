/** Undefined fields are omitted on JSON disk writes. */
export function pickStoredFields<T extends object, K extends keyof T>(
  record: T,
  keys: readonly K[]
): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {}
  for (const key of keys) {
    if (record[key] !== undefined) {
      picked[key] = record[key]
    }
  }
  return picked
}

export function omitStoredFields<T extends object, K extends keyof T>(
  record: T,
  keys: readonly K[]
): Omit<T, K> {
  const omitted = { ...record }
  for (const key of keys) {
    delete omitted[key]
  }
  return omitted
}

export function withoutKey<T>(
  record: Record<string, T> | undefined,
  key: string
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, key)) {
    return record
  }
  const next = { ...record }
  delete next[key]
  return next
}

export function childRecord<T>(
  record: Record<string, Record<string, T>>,
  key: string
): Record<string, T> {
  record[key] ??= {}
  return record[key]
}

export function filterRecord<T>(
  record: Record<string, T> | undefined,
  keep: (key: string, value: T) => boolean
): Record<string, T> | undefined {
  return (
    record && Object.fromEntries(Object.entries(record).filter(([key, value]) => keep(key, value)))
  )
}
