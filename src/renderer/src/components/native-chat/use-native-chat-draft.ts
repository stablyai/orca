import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../../shared/structured-agent-session-composer'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  placeNativeChatComposerDraftAddition,
  withNativeChatComposerDraftAddition,
  type NativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import { appendPromptDocumentText } from './native-chat-prompt-document-text'
import {
  readNativeChatDraftCache,
  subscribeToNativeChatDraftAppend,
  type NativeChatDraftCommit
} from './native-chat-draft-cache'

type HeldAddition = Pick<NativeChatComposerDraftAddition, 'text' | 'document' | 'textPolicy'>
/** A complete addition is already saved while the IME owns only its visible document. */
type CompositionHold = { scopeKey: string; shown: string; addition: HeldAddition }

export function useNativeChatDraft(
  scopeKey: string,
  isComposing: () => boolean
): {
  draft: string
  setDraft: (next: string | ((previous: string) => string), options?: { unsaved?: boolean }) => void
  commitDraft: NativeChatDraftCommit
  /** Commits the value an IME composition settled on, then shows what was appended during it. */
  flushDraftAppends: (settled: string) => void
} {
  const [hold, setHold] = useState<CompositionHold | null>(null)
  const holdRef = useRef<CompositionHold | null>(null)
  const updateHold = useCallback((next: CompositionHold | null) => {
    holdRef.current = next
    setHold(next)
  }, [])
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeToNativeChatComposerDraft(scopeKey, () => {
        if (!readNativeChatDraftCache(scopeKey) && holdRef.current?.scopeKey === scopeKey) {
          updateHold(null)
        }
        listener()
      }),
    [scopeKey, updateHold]
  )
  const stored = useSyncExternalStore(subscribe, () => readNativeChatDraftCache(scopeKey))
  useEffect(
    () => () => {
      holdRef.current = null
    },
    [scopeKey]
  )
  useEffect(
    () =>
      subscribeToNativeChatDraftAppend(scopeKey, (effective, previous) => {
        if (!isComposing()) {
          return
        }
        const held = holdRef.current?.scopeKey === scopeKey ? holdRef.current : null
        const incoming: HeldAddition = {
          text: effective.text,
          document: effective.document,
          textPolicy: effective.textPolicy
        }
        let addition = incoming
        if (
          held &&
          previous.text.trimEnd() &&
          !isLoneStructuredAgentSessionConversationCommand(previous.text.trimEnd())
        ) {
          const before = held.addition.text ?? ''
          const text = `${before.trimEnd()}\n\n${incoming.text ?? ''}`
          addition = {
            text,
            document: appendPromptDocumentText(
              held.addition.document,
              before,
              text,
              incoming.document
            ),
            textPolicy: 'append-repeated'
          }
        }
        updateHold({ scopeKey, shown: held ? held.shown : previous.text, addition })
      }),
    [isComposing, scopeKey, updateHold]
  )

  const commitDraft = useCallback(
    (change: Parameters<NativeChatDraftCommit>[0], options?: { unsaved?: boolean }) => {
      const held = holdRef.current?.scopeKey === scopeKey ? holdRef.current : null
      const current = readNativeChatComposerDraft(scopeKey)
      const visible = { ...current, ...change, document: change.document }
      const complete = held
        ? withNativeChatComposerDraftAddition(
            visible,
            placeNativeChatComposerDraftAddition(visible, held.addition)
          )
        : visible
      if (held) {
        updateHold({ ...held, shown: change.text })
      }
      updateNativeChatComposerDraft(
        scopeKey,
        {
          text: complete.text,
          document: complete.document,
          pastedTextFiles: { ...current.pastedTextFiles, ...change.pastedTextFiles },
          ...(options?.unsaved ? { unsavedText: complete.text } : {})
        },
        complete.text === '' ? 'immediate' : 'deferred'
      )
    },
    [scopeKey, updateHold]
  )

  const setDraft = useCallback(
    (next: string | ((previous: string) => string), options?: { unsaved?: boolean }) => {
      const held = holdRef.current?.scopeKey === scopeKey ? holdRef.current : null
      const previous = held ? held.shown : readNativeChatDraftCache(scopeKey)
      const text = typeof next === 'function' ? next(previous) : next
      if (text !== previous) {
        commitDraft({ text }, options)
      }
    },
    [scopeKey, commitDraft]
  )
  const flushDraftAppends = useCallback(
    (settled: string) => {
      setDraft(settled)
      if (holdRef.current?.scopeKey === scopeKey) {
        updateHold(null)
      }
    },
    [scopeKey, setDraft, updateHold]
  )
  const shownHold = hold?.scopeKey === scopeKey ? hold : null
  return { draft: shownHold ? shownHold.shown : stored, setDraft, commitDraft, flushDraftAppends }
}
