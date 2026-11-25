const INTEGER_KEY = /^(?:0|[1-9]\d*)$/
// Object.keys lists array-index keys first, ascending; only the others carry insertion order.
export function isIndexKey(key: string): boolean {
  return INTEGER_KEY.test(key) && Number(key) < 2 ** 32 - 1
}
