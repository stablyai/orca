export function preserveStringArrayIdentity<T extends string>(
  current: readonly T[] | null,
  next: T[] | null
): T[] | null {
  if (!current || !next) {
    return next
  }
  return current.length === next.length && current.every((value, index) => value === next[index])
    ? (current as T[])
    : next
}
