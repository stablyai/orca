import { useCallback, useRef, useState } from 'react'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'

type DraftUpdate = string | ((previous: string) => string)

/**
 * Composer draft state backed by the scope cache so a typed-but-unsent message
 * survives the composer unmounting on a TUI/GUI toggle. `scopeKey` is the stable
 * pane key also used for image attachments; when it changes (the composer is
 * reused for a different pane) the cached draft is reloaded.
 */
export function useNativeChatDraft(scopeKey: string): {
  draft: string
  setDraft: (next: DraftUpdate) => void
  setDraftWithoutPersist: (next: DraftUpdate) => void
  persistDraft: (text: string) => void
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

  const updateDraft = useCallback(
    (next: DraftUpdate, persist: boolean) => {
      setDraftState((previous) => {
        const resolved = typeof next === 'function' ? next(previous) : next
        if (persist) {
          writeNativeChatDraftCache(scopeKey, resolved)
        }
        return resolved
      })
    },
    [scopeKey]
  )

  // Persist every normal mutation through the cache. Composition updates use
  // the non-persisting setter until compositionend confirms the text.
  const setDraft = useCallback((next: DraftUpdate) => updateDraft(next, true), [updateDraft])
  const setDraftWithoutPersist = useCallback(
    (next: DraftUpdate) => updateDraft(next, false),
    [updateDraft]
  )
  const persistDraft = useCallback(
    (text: string) => writeNativeChatDraftCache(scopeKey, text),
    [scopeKey]
  )

  return { draft, setDraft, setDraftWithoutPersist, persistDraft }
}
