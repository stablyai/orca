type ReviewCacheEntry<T> = {
  data: T | null
}

export function selectReviewCacheEntry<T, Entry extends ReviewCacheEntry<T>>(
  cache: Readonly<Record<string, Entry>>,
  key: string | null
): Entry | undefined {
  return key ? cache[key] : undefined
}

export function selectReviewCacheData<T>(
  cache: Readonly<Record<string, ReviewCacheEntry<T>>>,
  key: string | null
): T | null {
  return selectReviewCacheEntry(cache, key)?.data ?? null
}
