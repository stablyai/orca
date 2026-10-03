import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  appendNativeChatDraftText,
  readNativeChatDraftCache,
  subscribeToNativeChatDraft,
  subscribeToNativeChatDraftAppend,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'

/**
 * Composer draft state for one view of a chat. `draftKey` names the chat (`nativeChatDraftKey`);
 * every view of it shares one draft, so what is typed here shows in the others and survives the
 * composer unmounting or Orca quitting. While this view's IME composes, the live composition
 * owns the field: other writers' text waits until it settles, as every programmatic draft does,
 * and the composition reaches the chat only once it settles.
 */
export function useNativeChatDraft(
  draftKey: string,
  isComposing: () => boolean
): {
  draft: string
  setDraft: (next: string | ((previous: string) => string)) => void
  /** Settles the draft after an IME composition: shows text appended meanwhile. */
  flushDraftAppends: () => void
} {
  const [draft, setDraftState] = useState(() => readNativeChatDraftCache(draftKey))
  // This view's draft for synchronous updates; React state only renders it.
  const draftRef = useRef(draft)
  // Appended while composing; settling (or a clear meanwhile) writes it after this view's text.
  const pendingAppendRef = useRef<{ draftKey: string; text: string } | null>(null)

  const showDraft = useCallback((next: string) => {
    draftRef.current = next
    setDraftState(next)
  }, [])

  // Reload when reused for a different chat, during render so the first paint is right.
  const [shownKey, setShownKey] = useState(draftKey)
  if (shownKey !== draftKey) {
    setShownKey(draftKey)
    setDraftState(readNativeChatDraftCache(draftKey))
  }
  useLayoutEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    // This view's own writes come back too; they hold what it already shows.
    const showShared = (): void => {
      const shared = readNativeChatDraftCache(draftKey)
      // A clear still reaches a composing field, which keeps only the composed segment.
      if (!isComposing() || shared === '') {
        showDraft(shared)
      }
    }
    const unsubscribeChange = subscribeToNativeChatDraft(draftKey, showShared)
    const unsubscribeAppend = subscribeToNativeChatDraftAppend(draftKey, (text) => {
      if (!isComposing()) {
        return
      }
      const pending = pendingAppendRef.current
      pendingAppendRef.current = {
        draftKey,
        text: pending?.draftKey === draftKey ? appendNativeChatDraftText(pending.text, text) : text
      }
    })
    // A write between this view's render and its subscription would otherwise never show here.
    showShared()
    return () => {
      unsubscribeChange()
      unsubscribeAppend()
    }
  }, [draftKey, isComposing, showDraft])

  // Accepts the same value/updater forms as a useState setter so call sites are drop-in.
  const setDraft = useCallback(
    (next: string | ((previous: string) => string)) => {
      const resolved = typeof next === 'function' ? next(draftRef.current) : next
      // A composition's keystrokes stay in this view until it settles, so a box still holding
      // text another view cleared never writes it back. A clear itself is written at once.
      if (!isComposing() || resolved === '') {
        const pending = pendingAppendRef.current
        writeNativeChatDraftCache(
          draftKey,
          pending?.draftKey === draftKey
            ? appendNativeChatDraftText(resolved, pending.text)
            : resolved,
          resolved === '' ? 'now' : 'after-pause'
        )
      }
      showDraft(resolved)
    },
    [draftKey, isComposing, showDraft]
  )

  const flushDraftAppends = useCallback(() => {
    const pending = pendingAppendRef.current
    pendingAppendRef.current = null
    if (pending?.draftKey === draftKey) {
      setDraft((previous) => appendNativeChatDraftText(previous, pending.text))
      return
    }
    // Another view wrote while this one composed; the settled composition is the newer intent.
    if (draftRef.current !== readNativeChatDraftCache(draftKey)) {
      setDraft(draftRef.current)
    }
  }, [draftKey, setDraft])

  return { draft, setDraft, flushDraftAppends }
}
