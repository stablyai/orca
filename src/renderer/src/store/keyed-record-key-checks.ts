import type { KeyedSnapshot } from './keyed-record-transitions'

// Tests prove each builder's named keys cover every entry it changed; production trusts them.
export function verifyNamedKeys(
  before: KeyedSnapshot,
  after: KeyedSnapshot,
  keys: ReadonlySet<string>
): void {
  if (import.meta.env.MODE !== 'test') {
    return
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

// Addressed records promise surviving keys keep their order and added keys follow them.
export function keepsKeyOrder(previous: KeyedSnapshot, next: KeyedSnapshot): boolean {
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
  return nextKeys.slice(index).every((key) => !Object.hasOwn(previous, key))
}
