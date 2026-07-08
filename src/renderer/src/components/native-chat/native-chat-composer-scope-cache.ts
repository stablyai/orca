// Shared LRU bound for the native-chat composer's per-scope caches (draft text
// and image attachments), both keyed by `targetPtyId ?? terminalTabId`. The
// caches exist so an in-progress message survives the composer unmounting on a
// TUI/GUI toggle, but a scope key for a permanently-removed pane is never
// revisited, so without a bound its unsent entry would linger for the renderer's
// whole session. delete-then-set keeps the actively-edited scope most-recent so
// eviction only sheds the oldest untouched scopes.
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
