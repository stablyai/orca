import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { withNativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import type { NativeChatDraftAppend } from './native-chat-composer-draft-memory'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import {
  subscribeToNativeChatComposerDraft,
  subscribeToNativeChatComposerDraftAppend,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'

/** Text appended mid-IME-composition: saved at once, shown once the composition settles. */
type CompositionHold = {
  scopeKey: string
  shown: string
  base: NativeChatComposerDraft
  additions: NativeChatDraftAppend[]
}

/** Mutate the durable scope store’s current draft, never a composer copy, so unsent text survives toggles, remounts and restarts. */
export function useNativeChatDraft(
  scopeKey: string,
  isComposing: () => boolean
): {
  draft: string
  setDraft: (next: string | ((previous: string) => string), options?: { unsaved?: boolean }) => void
  /** Shows text appended during an IME composition, which owns the field until it settles. */
  flushDraftAppends: () => void
} {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(scopeKey, listener),
    [scopeKey]
  )
  const stored = useSyncExternalStore(subscribe, () => readNativeChatDraftCache(scopeKey))
  const [hold, setHold] = useState<CompositionHold | null>(null)
  // Read by callbacks between renders; only they change it, always together with the state.
  const holdRef = useRef<CompositionHold | null>(null)
  const updateHold = useCallback((next: CompositionHold | null) => {
    holdRef.current = next
    setHold(next)
  }, [])
  useEffect(
    () => () => {
      holdRef.current = null
    },
    []
  )

  useEffect(
    () =>
      subscribeToNativeChatComposerDraftAppend(scopeKey, (addition, previous) => {
        if (!isComposing()) {
          return
        }
        const held = holdRef.current?.scopeKey === scopeKey ? holdRef.current : null
        updateHold({
          scopeKey,
          shown: held ? held.shown : previous.text,
          base: held?.base ?? previous,
          additions: [...(held?.additions ?? []), addition]
        })
      }),
    [isComposing, scopeKey, updateHold]
  )

  const setDraft = useCallback(
    (next: string | ((previous: string) => string), options?: { unsaved?: boolean }) => {
      const held = holdRef.current?.scopeKey === scopeKey ? holdRef.current : null
      const previous = held ? held.shown : readNativeChatDraftCache(scopeKey)
      const resolved = typeof next === 'function' ? next(previous) : next
      if (held) {
        updateHold({ ...held, shown: resolved })
      }
      if (held) {
        const current = readNativeChatComposerDraft(scopeKey)
        const base =
          current.text === resolved
            ? current
            : { ...held.base, text: resolved, document: undefined }
        const merged = held.additions.reduce<NativeChatComposerDraft>(
          (draft, addition) => ({
            ...draft,
            ...(typeof addition === 'function'
              ? addition(draft)
              : withNativeChatComposerDraftAddition(draft, addition))
          }),
          base
        )
        updateNativeChatComposerDraft(scopeKey, merged, 'deferred')
      } else {
        writeNativeChatDraftCache(scopeKey, resolved, options)
      }
    },
    [scopeKey, updateHold]
  )

  const flushDraftAppends = useCallback(() => {
    if (holdRef.current?.scopeKey === scopeKey) {
      updateHold(null)
    }
  }, [scopeKey, updateHold])

  const shownHold = hold?.scopeKey === scopeKey ? hold : null
  return { draft: shownHold ? shownHold.shown : stored, setDraft, flushDraftAppends }
}
