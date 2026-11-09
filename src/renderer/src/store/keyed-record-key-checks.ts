import type { KeyOrder, KeyedSnapshot } from './keyed-record-transitions'

// Tests prove each builder's named keys and declared key order; production trusts the declaration.
export function verifyNamedKeys(
  before: KeyedSnapshot,
  after: KeyedSnapshot,
  keys: ReadonlySet<string>,
  order: KeyOrder
): void {
  if (import.meta.env.MODE !== 'test') {
    return
  }
  if (order === 'appended' && !keepsKeyOrder(before, after, keys)) {
    throw new Error("keyed record write moved keys; annotate it with order 'reordered'")
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      !keys.has(key) &&
      (Object.hasOwn(before, key) !== Object.hasOwn(after, key) || before[key] !== after[key])
    ) {
      throw new Error(`keyed record write changed unnamed key ${key}`)
    }
  }
}

const INTEGER_KEY = /^(?:0|[1-9]\d*)$/
// Object.keys lists array-index keys first, ascending; only the others carry insertion order.
export function isIndexKey(key: string): boolean {
  return INTEGER_KEY.test(key) && Number(key) < 2 ** 32 - 1
}

// Surviving keys keep their order and added keys follow them, in the order the writer named them.
function keepsKeyOrder(
  previous: KeyedSnapshot,
  next: KeyedSnapshot,
  named: ReadonlySet<string>
): boolean {
  const nextKeys = Object.keys(next).filter((key) => !isIndexKey(key))
  let index = 0
  for (const key of Object.keys(previous)) {
    if (!isIndexKey(key) && Object.hasOwn(next, key)) {
      if (nextKeys[index] !== key) {
        return false
      }
      index++
    }
  }
  const appended = nextKeys.slice(index)
  const declared = [...named].filter((key) => !isIndexKey(key) && !Object.hasOwn(previous, key))
  return (
    appended.every((key) => !Object.hasOwn(previous, key)) &&
    appended.length === declared.filter((key) => Object.hasOwn(next, key)).length &&
    appended.every(
      (key, position) => key === declared.filter((k) => Object.hasOwn(next, k))[position]
    )
  )
}
