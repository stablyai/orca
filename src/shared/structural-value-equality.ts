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
  const pending = [compareValueChildren(a, b, policy)]
  while (pending.length > 0) {
    const next = pending.at(-1)!.next()
    if (next.done) {
      if (!next.value) {
        return false
      }
      pending.pop()
    } else {
      pending.push(compareValueChildren(next.value[0], next.value[1], policy))
    }
  }
  return true
}

// Suspend each parent to preserve short-circuit reads and sparse-array every semantics.
function* compareValueChildren(
  a: unknown,
  b: unknown,
  policy: ValueEqualityPolicy
): Generator<[unknown, unknown], boolean> {
  if (policy.sameValueLeaves ? Object.is(a, b) : a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    const length = a.length
    for (let index = 0; index < length; index += 1) {
      if (index in a) {
        yield [a[index], b[index]]
      }
    }
    return true
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) {
    return false
  }
  const ownKeys = Object.keys(a)
  const keys = policy.absentKeyEqualsUndefined ? new Set([...ownKeys, ...Object.keys(b)]) : ownKeys
  if (!policy.absentKeyEqualsUndefined && ownKeys.length !== Object.keys(b).length) {
    return false
  }
  for (const key of keys) {
    if (!policy.absentKeyEqualsUndefined && !Object.hasOwn(b, key)) {
      return false
    }
    yield [a[key], b[key]]
  }
  return true
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
