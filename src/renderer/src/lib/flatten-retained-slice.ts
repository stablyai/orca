/**
 * V8 backs `String.prototype.slice` with a SlicedString that points at the whole parent, so a
 * short tail of a large chunk keeps that whole chunk alive. Concatenating forces a ConsString
 * whose flattening allocates a fresh sequential string of just this length, dropping the parent.
 *
 * Use this whenever a slice outlives the value it was cut from — a queued remainder, or an
 * overlap-trimmed payload handed to a component that will hold it.
 */
export function flattenRetainedSlice(value: string): string {
  return value.length === 0 ? value : `${value} `.slice(0, -1)
}
