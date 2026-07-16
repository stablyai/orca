import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { parseInteractivePrompt } from './native-chat-interactive-prompt'
import { nativeChatCardDismissKey } from './native-chat-dismiss-key'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

/**
 * Render the live interactive card for the pane while the agent's
 * `interactivePrompt` is present: a question wizard (precedence) or a tool
 * approval. Cleared by the host once the agent moves on, so it disappears
 * automatically. Sends through the composer's verified runtime path (R8/R6):
 * answers via agent-specific paste or selector keystrokes; cancel/deny as ESC.
 * Guarded by `canSend` so a mobile presence-lock blocks desktop sends too.
 *
 * Dismiss-on-answer (mobile parity): the live status lingers after answering —
 * the agent emits a post-tool event carrying the same prompt — so we track the
 * answered prompt by content key and hide the card until a genuinely different
 * prompt arrives. The dismissal resets once the prompt clears, so a later
 * (even identical) prompt shows again instead of staying hidden.
 */
export function NativeChatInteractiveCard({
  paneKey,
  send,
  canSend,
  onShowingQuestionChange,
  answerInputRef
}: {
  paneKey: string
  send: NativeChatInteractiveSend
  canSend: boolean
  /** Reports whether a question card is on screen so the view can replace the
   *  composer with it (the card's free-text row is the answer input). */
  onShowingQuestionChange?: (showing: boolean) => void
  /** Forwarded to the question card's free-text row so pane-level Paste keeps
   *  a target while the composer is unmounted. */
  answerInputRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element | null {
  const interactivePrompt = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.interactivePrompt ?? null
  )
  // Thread the sibling `toolName` from the same status entry so the question
  // parser can dispatch through the tool's registered parser (mobile parity).
  const interactiveToolName = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.toolName ?? null)
  const { sendAnswer, sendRaw, cancelPending, cancel } = send

  const card = useMemo(
    () => parseInteractivePrompt(interactivePrompt, interactiveToolName ?? undefined),
    [interactivePrompt, interactiveToolName]
  )
  const cardKey = useMemo(() => nativeChatCardDismissKey(card), [card])
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  // A question answer is a paced multi-step write (body→Enter per question); keep
  // the card up until it settles instead of dismissing on the click, so it doesn't
  // vanish mid-send. `submitting` also gates a second submit racing the first.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const clearDismissTimer = useCallback((): void => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    submittingRef.current = false
    setSubmitting(false)
  }, [])
  // A replacement prompt, ownership loss, or unmount must stop both timers and
  // PTY writes during commit, before an old answer can type into the new prompt.
  useLayoutEffect(
    () => () => {
      clearDismissTimer()
      cancelPending()
    },
    [canSend, cardKey, cancelPending, clearDismissTimer]
  )

  // Forget the dismissal once the prompt clears so a fresh prompt can show.
  const present = card != null
  useEffect(() => {
    if (!present) {
      setDismissedKey(null)
      clearDismissTimer()
    }
  }, [present, clearDismissTimer])

  // Tell the view when a question card is up so it can hide the composer (this
  // card supplies its own input). Reset on unmount so the composer comes back.
  const showingQuestion = card?.kind === 'question' && canSend && cardKey !== dismissedKey
  useEffect(() => {
    onShowingQuestionChange?.(showingQuestion)
    return () => onShowingQuestionChange?.(false)
  }, [showingQuestion, onShowingQuestionChange])

  if (!card || !canSend || cardKey === dismissedKey) {
    return null
  }
  if (card.kind === 'question') {
    return (
      <NativeChatQuestionCard
        key={cardKey ?? 'question'}
        prompt={card.prompt}
        isSubmitting={submitting}
        answerInputRef={answerInputRef}
        onAnswer={(selections) => {
          if (submittingRef.current) {
            return
          }
          submittingRef.current = true
          const settleMs = sendAnswer(card.prompt, selections)
          if (settleMs <= 0) {
            // Keep the actionable card visible when its PTY disappeared between
            // render and submit; the next live target update can make it retryable.
            submittingRef.current = false
            return
          }
          setSubmitting(true)
          // Hold the card until the paced write finishes, then mark it answered
          // (which hides it and restores the composer).
          dismissTimerRef.current = setTimeout(() => {
            cancelPending()
            setDismissedKey(cardKey)
            submittingRef.current = false
            setSubmitting(false)
            dismissTimerRef.current = null
          }, settleMs)
        }}
        onCancel={() => {
          clearDismissTimer()
          setDismissedKey(cardKey)
          cancel()
        }}
      />
    )
  }
  return (
    <NativeChatApprovalCard
      approval={card.approval}
      onChoose={(raw) => {
        setDismissedKey(cardKey)
        sendRaw(raw)
      }}
    />
  )
}
