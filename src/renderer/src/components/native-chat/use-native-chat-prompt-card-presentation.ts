import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '../../store'
import {
  nativeChatCardDismissKey,
  nativeChatPromptDismissalMatches,
  nativeChatPromptOccurrenceKey,
  nativeChatPromptWaitStartedAt
} from '../../../../shared/native-chat-prompt-dismiss-key'
import {
  nativeChatPromptDismissals as dismissals,
  type NativeChatPromptDismissal
} from './native-chat-prompt-dismissals'
import type { InteractivePromptCard } from '../../../../shared/native-chat-interactive-prompt'

export type NativeChatPromptCardPresentation = {
  /** The card that owns the input region now; null leaves it to the composer. */
  card: InteractivePromptCard
  /** The occurrence the user collapsed to a strip above the composer. */
  collapsedCard: InteractivePromptCard
  /** Identifies this prompt occurrence; a new one remounts the card with fresh state. */
  occurrenceKey: string | null
  /** Hide this occurrence once its answer was delivered. */
  dismiss: () => void
  collapse: () => void
  expand: () => void
}

/** Derive card/composer ownership in render; persist occurrence-only dismissal across remounts without asserting agent progress. */
export function useNativeChatPromptCardPresentation({
  paneKey,
  targetPtyId = null,
  card,
  canSend,
  transcriptSettled = true
}: {
  paneKey: string
  targetPtyId?: string | null
  card: InteractivePromptCard
  /** False while a phone holds this PTY: no card answers from here, and the composer shows why. */
  canSend: boolean
  /** While the transcript loads, an absent transcript card is unknown, not cleared. */
  transcriptSettled?: boolean
}): NativeChatPromptCardPresentation {
  const startedAt = useAppStore((s) =>
    nativeChatPromptWaitStartedAt(card, s.agentStatusByPaneKey[paneKey])
  )
  const content = nativeChatCardDismissKey(card)
  const promptKey = nativeChatPromptOccurrenceKey(card, content, startedAt)
  const scopeKey = JSON.stringify([paneKey, targetPtyId])
  const occurrenceKey = promptKey === null ? null : `${scopeKey}:${promptKey}`
  const occurrence = useMemo(() => ({ occurrenceKey, canSend }), [occurrenceKey, canSend])
  const activeOccurrenceRef = useRef<object | null>(null)
  useLayoutEffect(() => {
    activeOccurrenceRef.current = occurrence
    return () => {
      activeOccurrenceRef.current = null
    }
  }, [occurrence])
  const dismissal = useSyncExternalStore(dismissals.subscribe, () => dismissals.read(paneKey))
  const matches = nativeChatPromptDismissalMatches(dismissal, content, startedAt)
  // Retire cleared/changed dismissals so later identical prompts can appear.
  useLayoutEffect(() => {
    if (dismissal !== undefined && !matches && (content !== null || transcriptSettled)) {
      dismissals.forget(paneKey)
    }
  }, [dismissal, matches, content, transcriptSettled, paneKey])
  // Without a wait-start stamp, an unobserved interval could contain a new occurrence.
  useLayoutEffect(
    () => () => {
      if (dismissals.read(paneKey)?.startedAt === null) {
        dismissals.forget(paneKey)
      }
    },
    [paneKey]
  )
  const record = useCallback(
    (state: NativeChatPromptDismissal['state']) => {
      if (activeOccurrenceRef.current === occurrence && canSend && content !== null) {
        dismissals.write(paneKey, { content, startedAt, state })
      }
    },
    [occurrence, canSend, content, startedAt, paneKey]
  )
  const dismiss = useCallback(() => record('answered'), [record])
  const collapse = useCallback(() => record('collapsed'), [record])
  const expand = useCallback(() => dismissals.forget(paneKey), [paneKey])
  const shown = card !== null && canSend
  return {
    card: shown && !matches ? card : null,
    collapsedCard: shown && matches && dismissal?.state === 'collapsed' ? card : null,
    occurrenceKey,
    dismiss,
    collapse,
    expand
  }
}
