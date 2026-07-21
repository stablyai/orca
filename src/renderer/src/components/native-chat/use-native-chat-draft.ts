import { useCallback, useRef, useState } from 'react'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'

/**
 * Composer draft state backed by the scope cache so a typed-but-unsent message
 * survives the composer unmounting on a TUI/GUI toggle. `scopeKey` is the stable
 * pane key also used for image attachments; when it changes (the composer is
 * reused for a different pane) the cached draft is reloaded.
 */
export function useNativeChatDraft(scopeKey: string): {
  draft: string
  setDraft: (next: string | ((previous: string) => string)) => void
} {
  const [draft, setDraftState] = useState(() => readNativeChatDraftCache(scopeKey))

  // Reload the cached draft when reused for a different pane (scope change),
  // adjusting state during render rather than in an effect so the restored draft
  // is visible on the first paint after the switch.
  const lastScopeKey = useRef(scopeKey)
  if (lastScopeKey.current !== scopeKey) {
    lastScopeKey.current = scopeKey
    setDraftState(readNativeChatDraftCache(scopeKey))
  }

  // Persist every mutation through the cache. Accepts the same value/updater
  // forms as a useState setter so call sites are drop-in.
  const setDraft = useCallback(
    (next: string | ((previous: string) => string)) => {
      setDraftState((previous) => {
        const resolved = typeof next === 'function' ? next(previous) : next
        writeNativeChatDraftCache(scopeKey, resolved)
        return resolved
      })
    },
    [scopeKey]
  )

  return { draft, setDraft }
}
