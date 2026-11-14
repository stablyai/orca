// V8 slices can retain their full parent; force a standalone copy for values that outlive it.
export function flattenRetainedSlice(value: string): string {
  return value.length === 0 ? value : `${value} `.slice(0, -1)
}
