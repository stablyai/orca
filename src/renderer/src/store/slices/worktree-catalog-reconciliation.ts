type CatalogRow = { id: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function catalogValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => catalogValuesEqual(value, right[index]))
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (!catalogValuesEqual(left[key], right[key])) {
      return false
    }
  }
  return true
}

export function reuseEqualCatalogRows<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): T[] {
  if (!current) {
    return [...incoming]
  }
  const currentById = new Map<string, T[]>()
  for (const row of current) {
    const candidates = currentById.get(row.id)
    if (candidates) {
      candidates.push(row)
    } else {
      currentById.set(row.id, [row])
    }
  }
  const reconciled = incoming.map((row) => {
    const candidates = currentById.get(row.id)
    const previousIndex = candidates?.findIndex((candidate) => catalogValuesEqual(candidate, row))
    return previousIndex !== undefined && previousIndex >= 0
      ? candidates!.splice(previousIndex, 1)[0]
      : row
  })
  return current.length === reconciled.length &&
    current.every((row, index) => row === reconciled[index])
    ? (current as T[])
    : reconciled
}

export function catalogRowsEqual<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): boolean {
  if (current === incoming) {
    return true
  }
  return reuseEqualCatalogRows(current, incoming) === current
}
