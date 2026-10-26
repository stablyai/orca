// IPC/hydration rebuilds catalog objects; reference checks would mark every row changed.
// Walk only arrays/plain records so exotic values cannot masquerade as empty records.

type ValueEqualityPolicy = {
  // Object.is equates NaN and distinguishes signed zero; === does the inverse.
  readonly sameValueLeaves: boolean
  readonly absentKeyEqualsUndefined: boolean
}

const STRICT_OWN_KEYS: ValueEqualityPolicy = {
  sameValueLeaves: false,
  absentKeyEqualsUndefined: false
}

const UNION_OF_KEYS: ValueEqualityPolicy = {
  sameValueLeaves: true,
  absentKeyEqualsUndefined: true
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function valuesEqual(a: unknown, b: unknown, policy: ValueEqualityPolicy): boolean {
  if (policy.sameValueLeaves ? Object.is(a, b) : a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => valuesEqual(item, b[index], policy))
    )
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) {
    return false
  }
  if (policy.absentKeyEqualsUndefined) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!valuesEqual(a[key], b[key], policy)) {
        return false
      }
    }
    return true
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) {
    return false
  }
  return keys.every((key) => Object.hasOwn(b, key) && valuesEqual(a[key], b[key], policy))
}

/** Compare leaves with === and require identical own keys: repo/project merges use in, making undefined distinct from absence. */
export function structuralValuesEqual(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, STRICT_OWN_KEYS)
}

/** Use Object.is leaves and ignore absent-vs-undefined keys for catalog rows that omit undefined over the wire. */
export function structuralValuesEqualIgnoringUndefined(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, UNION_OF_KEYS)
}
