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
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    for (let index = 0; index < a.length; index++) {
      if (!valuesEqual(a[index], b[index], policy)) {
        return false
      }
    }
    return true
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) {
    return false
  }
  if (policy.absentKeyEqualsUndefined) {
    for (const key in a) {
      if (Object.hasOwn(a, key) && !valuesEqual(a[key], b[key], policy)) {
        return false
      }
    }
    for (const key in b) {
      if (Object.hasOwn(b, key) && !Object.hasOwn(a, key) && b[key] !== undefined) {
        return false
      }
    }
    return true
  }
  let aKeyCount = 0
  for (const key in a) {
    if (!Object.hasOwn(a, key)) {
      continue
    }
    aKeyCount += 1
    if (!Object.hasOwn(b, key) || !valuesEqual(a[key], b[key], policy)) {
      return false
    }
  }
  let bKeyCount = 0
  for (const key in b) {
    if (Object.hasOwn(b, key)) {
      bKeyCount += 1
    }
  }
  return aKeyCount === bKeyCount
}

/** Compare leaves with === and require identical own keys: repo/project merges use in, making undefined distinct from absence. */
export function structuralValuesEqual(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, STRICT_OWN_KEYS)
}

/** Use Object.is leaves and ignore absent-vs-undefined keys for catalog rows that omit undefined over the wire. */
export function structuralValuesEqualIgnoringUndefined(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, UNION_OF_KEYS)
}
