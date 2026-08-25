export function staleOrThrow<T>(fallback: T | null | undefined, error: unknown): NonNullable<T> {
  if (fallback != null) {
    return fallback
  }
  throw error
}
