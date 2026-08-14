// Why: catalog reconcilers compare rows that IPC structured-clone (and main's hydration) rebuild on
// every fetch, so a reference compare reports every row as changed and nothing ever reconciles.
// Only plain records and arrays are walked; anything exotic (Date, Map, class instance) falls back
// to reference equality rather than being mistaken for an empty record.

type ValueEqualityPolicy = {
  // Why: `Object.is` makes NaN equal NaN but 0 unequal -0; `===` does the opposite.
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

/**
 * Structural compare where an absent own key differs from a key that is present and holds
 * `undefined`, and leaves compare with `===`.
 *
 * Why the strict key set: the repo/project merges branch on `'localWindowsRuntimePreference' in
 * project`, so a key appearing or disappearing is a real change even when its value is `undefined`.
 */
export function structuralValuesEqual(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, STRICT_OWN_KEYS)
}

/**
 * Structural compare that treats an absent own key as equal to a key holding `undefined`, and
 * compares leaves with `Object.is`.
 *
 * Why the loose key set: locally constructed worktree catalog rows carry explicit `undefined`
 * fields that the host simply omits, and no consumer of those rows uses the `in` operator.
 */
export function structuralValuesEqualIgnoringUndefined(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, UNION_OF_KEYS)
}
