import { useCallback, useEffect, useRef, useState } from 'react'
import {
  appendNativeChatDraftText,
  readNativeChatDraftCache,
  subscribeToNativeChatDraftAppend,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'

/**
 * Composer draft state backed by the scope cache so a typed-but-unsent message
 * survives the composer unmounting on a TUI/GUI toggle. `scopeKey` is the stable
 * pane key also used for image attachments; when it changes (the composer is
 * reused for a different pane) the cached draft is reloaded.
 */
export function useNativeChatDraft(
  scopeKey: string,
  isComposing: () => boolean
): {
  draft: string
  setDraft: (next: string | ((previous: string) => string)) => void
  /** Shows text appended during an IME composition, which owns the field until it settles. */
  flushDraftAppends: () => void
} {
  const [draft, setDraftState] = useState(() => readNativeChatDraftCache(scopeKey))
  // Appended while composing: the editor's own writes would erase it, so the cache keeps it after them.
  const pendingAppendRef = useRef<{ scopeKey: string; text: string } | null>(null)

  // Reload the cached draft when reused for a different pane (scope change),
  // adjusting state during render rather than in an effect so the restored draft
  // is visible on the first paint after the switch.
  const lastScopeKey = useRef(scopeKey)
  if (lastScopeKey.current !== scopeKey) {
    lastScopeKey.current = scopeKey
    setDraftState(readNativeChatDraftCache(scopeKey))
  }

  useEffect(
    () =>
      subscribeToNativeChatDraftAppend(scopeKey, (text) => {
        if (!isComposing()) {
          setDraftState(readNativeChatDraftCache(scopeKey))
          return
        }
        const pending = pendingAppendRef.current
        pendingAppendRef.current = {
          scopeKey,
          text:
            pending?.scopeKey === scopeKey ? appendNativeChatDraftText(pending.text, text) : text
        }
      }),
    [isComposing, scopeKey]
  )

  // Persist every mutation through the cache. Accepts the same value/updater
  // forms as a useState setter so call sites are drop-in.
  const setDraft = useCallback(
    (next: string | ((previous: string) => string)) => {
      setDraftState((previous) => {
        const resolved = typeof next === 'function' ? next(previous) : next
        const pending = pendingAppendRef.current
        writeNativeChatDraftCache(
          scopeKey,
          pending?.scopeKey === scopeKey
            ? appendNativeChatDraftText(resolved, pending.text)
            : resolved
        )
        return resolved
      })
    },
    [scopeKey]
  )

  const flushDraftAppends = useCallback(() => {
    const pending = pendingAppendRef.current
    pendingAppendRef.current = null
    if (pending?.scopeKey === scopeKey) {
      setDraft((previous) => appendNativeChatDraftText(previous, pending.text))
    }
  }, [scopeKey, setDraft])

  return { draft, setDraft, flushDraftAppends }
}
