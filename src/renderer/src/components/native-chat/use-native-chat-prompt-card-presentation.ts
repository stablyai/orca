import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '../../store'
import { nativeChatCardDismissKey } from './native-chat-dismiss-key'
import {
  nativeChatPromptDismissals as dismissals,
  type NativeChatPromptDismissal
} from './native-chat-prompt-dismissals'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'

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

/**
 * Which prompt card the pane shows, derived in render so the card and the composer never share a
 * commit. Dismissal is presentation only: it hides or collapses one occurrence and never says the
 * agent moved on. A lingering live status must not reshow it, including after the view remounts.
 */
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
  // Why the wait's start: two prompts with the same text are separate occurrences.
  const startedAt = useAppStore((s) => {
    const entry = s.agentStatusByPaneKey[paneKey]
    return card && entry?.interactivePrompt ? (entry.stateStartedAt ?? null) : null
  })
  const content = nativeChatCardDismissKey(card)
  const promptKey =
    content === null || card?.kind !== 'approval' ? content : `${content}@${startedAt}`
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
  // A transcript-only card matches its status-backed record across the post-answer handoff.
  const matches =
    dismissal !== undefined &&
    dismissal.content === content &&
    (startedAt === null || dismissal.startedAt === startedAt)
  // Why retire on a cleared or changed prompt: a later, identical question must show again.
  useLayoutEffect(() => {
    if (dismissal !== undefined && !matches && (content !== null || transcriptSettled)) {
      dismissals.forget(paneKey)
    }
  }, [dismissal, matches, content, transcriptSettled, paneKey])
  // Why: with no wait start to tell occurrences apart, an unobserved stretch may hide a new one.
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
