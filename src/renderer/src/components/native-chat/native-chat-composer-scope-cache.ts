// LRU bound for the native-chat composer's per-scope caches. Drafts die with their chat
// (discardNativeChatDrafts); this bound is the backstop for chats that end where this client
// never sees it, such as a session closed from another device. delete-then-set keeps the
// actively-edited scope most-recent so eviction only sheds the oldest untouched scopes.
export const NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX = 128

export function setBoundedScopeCacheEntry<T>(
  cache: Map<string, T>,
  scopeKey: string,
  value: T,
  options: {
    onEvict?: (evictedScopeKey: string) => void
    /** A scope still in use is never evicted, even past the bound. */
    inUse?: (scopeKey: string) => boolean
  } = {}
): void {
  cache.delete(scopeKey)
  cache.set(scopeKey, value)
  let excess = cache.size - NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX
  for (const key of cache.keys()) {
    if (excess <= 0) {
      break
    }
    if (key === scopeKey || options.inUse?.(key)) {
      continue
    }
    cache.delete(key)
    options.onEvict?.(key)
    excess -= 1
  }
}
