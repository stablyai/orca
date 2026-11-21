// Equality of JSON-shaped values (what a host read decodes to), compared field by field without copying.

/** A plain JSON object (not an array or null). */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => jsonEqual(value, b[index]))
    )
  }
  if (!isJsonRecord(a) || !isJsonRecord(b)) {
    return false
  }
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  )
}
