// Bound pane-keyed draft/image caches: TUI/chat toggles need retention, but removed panes are never revisited.
// Delete-then-set keeps edited scopes recent; evict only the oldest untouched drafts.
export const NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX = 128

export function setBoundedScopeCacheEntry<T>(
  cache: Map<string, T>,
  scopeKey: string,
  value: T
): void {
  cache.delete(scopeKey)
  cache.set(scopeKey, value)
  while (cache.size > NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
}
