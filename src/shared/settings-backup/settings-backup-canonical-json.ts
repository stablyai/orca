const MAX_JSON_DEPTH = 32

/** Plain JSON data only: no prototypes, functions, non-finite numbers or runaway nesting. */
export function isPlainJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) {
    return false
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every((item) => isPlainJsonValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return false
    }
    return Object.values(value).every((item) => isPlainJsonValue(item, depth + 1))
  }
  return false
}

/** JSON with object keys sorted, so equal data always hashes and compares the same. */
export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  return toCanonicalJson(left ?? null) === toCanonicalJson(right ?? null)
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
    return Object.fromEntries(entries.map(([key, nested]) => [key, sortKeysDeep(nested)]))
  }
  return value
}
