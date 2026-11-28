export function preserveStringArrayIdentity<T extends readonly string[] | null>(
  current: T,
  next: T
): T {
  if (!current || !next) {
    return next
  }
  return current.length === next.length && current.every((value, index) => value === next[index])
    ? current
    : next
}
