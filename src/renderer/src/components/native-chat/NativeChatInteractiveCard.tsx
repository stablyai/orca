import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { resolveNativeChatAsk } from '../../../../shared/native-chat-ask'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { parseInteractivePrompt } from './native-chat-interactive-prompt'
import { nativeChatCardDismissKey } from './native-chat-dismiss-key'
import { nativeChatAnswerConfirmDeadlineMs } from './native-chat-answer-confirmation'
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
 *
 * That dismissal is provisional until the ask actually resolves. Delivered
 * keystrokes can leave a selector untouched, which strands the session on a
 * live question behind a hidden card (#16865). While an answer is unconfirmed
 * the pane keeps its waiting state, and a deadline restores the card so the
 * question is visible and answerable again rather than showing false progress.
 *
 * The transcript is the second source (mobile parity again): a question that the
 * live status never delivered — headless host, relay gap, replay, reconnect —
 * still has its unresolved tool call in the messages we already parsed. Without
 * it the composer stays mounted over a pane parked on a selector, and the next
 * send commits the highlighted option instead of the typed message (#11761).
 */
export function NativeChatInteractiveCard({
  paneKey,
  send,
  canSend,
  messages,
  transcriptSettled,
  onShowingQuestionChange,
  answerInputRef
}: {
  paneKey: string
  send: NativeChatInteractiveSend
  canSend: boolean
  /** Transcript to fall back on when live status carries no prompt. Pass the
   *  command-boundary-trimmed messages so an ask abandoned via `/clear` stays gone. */
  messages?: readonly NativeChatMessage[]
  transcriptSettled: boolean
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

  const card = useMemo(() => {
    const statusCard = parseInteractivePrompt(interactivePrompt, interactiveToolName ?? undefined)
    if (statusCard?.kind === 'approval') {
      return statusCard
    }
    const prompt = resolveNativeChatAsk({
      liveAsk: statusCard?.prompt ?? null,
      messages: messages ?? [],
      transcriptSettled: transcriptSettled && messages != null
    })
    return prompt ? { kind: 'question' as const, prompt } : null
  }, [interactivePrompt, interactiveToolName, messages, transcriptSettled])
  const cardKey = useMemo(() => nativeChatCardDismissKey(card), [card])
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  // A question answer is a paced multi-step write (body→Enter per question); keep
  // the card up until it settles instead of dismissing on the click, so it doesn't
  // vanish mid-send. `submitting` also gates a second submit racing the first.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  // An answered-but-unconfirmed card: the key it dismissed under, the deadline
  // timer that brings it back, and the pane-wait clear to run once the ask
  // actually resolves.
  const awaitingConfirmationRef = useRef<{
    cardKey: string | null
    timer: ReturnType<typeof setTimeout>
    confirmAnswered: () => void
  } | null>(null)
  const clearConfirmationWait = useCallback((): void => {
    if (awaitingConfirmationRef.current) {
      clearTimeout(awaitingConfirmationRef.current.timer)
      awaitingConfirmationRef.current = null
    }
  }, [])
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
  // The deadline timer outlives a card swap on purpose (a replacement prompt
  // confirms the old answer), so only a full unmount discards it.
  useEffect(() => clearConfirmationWait, [clearConfirmationWait])

  // Forget the dismissal once the prompt clears so a fresh prompt can show.
  // A cleared (or replaced) ask is also the confirmation an answer was accepted:
  // the tool call closed in the transcript, or a fresh hook status dropped the
  // prompt. Either way the pane's question wait can now be cleared honestly.
  useEffect(() => {
    const awaiting = awaitingConfirmationRef.current
    if (awaiting && awaiting.cardKey !== cardKey) {
      awaiting.confirmAnswered()
      clearConfirmationWait()
    }
  }, [cardKey, clearConfirmationWait])
  const present = card != null
  useEffect(() => {
    if (!present) {
      setDismissedKey(null)
      clearDismissTimer()
      // An answer is paced over seconds, so the ask can be retired mid-send
      // (#16865). Drop the remaining keystroke groups: with the selector gone
      // they land in the composer as literal text, and a trailing Enter submits
      // it. Also retires the deadline — a resolved ask owes no confirmation.
      cancelPending()
      clearConfirmationWait()
    }
  }, [present, clearDismissTimer, cancelPending, clearConfirmationWait])

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
          const dismissAnsweredCard = (
            confirmAnswered: () => void,
            settleAfterMs: number
          ): void => {
            setDismissedKey(cardKey)
            submittingRef.current = false
            setSubmitting(false)
            dismissTimerRef.current = null
            // Delivery is not acceptance: hold the pane's wait and bring the
            // card back if the ask never resolves (#16865).
            clearConfirmationWait()
            awaitingConfirmationRef.current = {
              cardKey,
              confirmAnswered,
              timer: setTimeout(() => {
                awaitingConfirmationRef.current = null
                setDismissedKey(null)
              }, nativeChatAnswerConfirmDeadlineMs(settleAfterMs))
            }
          }
          const keepRejectedAnswerVisible = (): void => {
            submittingRef.current = false
            setSubmitting(false)
          }
          const result: ReturnType<typeof sendAnswer> = sendAnswer(
            card.prompt,
            selections,
            (delivered) => {
              if (delivered) {
                dismissAnsweredCard(result.confirmAnswered, result.settleAfterMs)
              } else {
                keepRejectedAnswerVisible()
              }
            }
          )
          if (result.settleAfterMs <= 0) {
            // Keep the actionable card visible when its PTY disappeared between
            // render and submit; the next live target update can make it retryable.
            keepRejectedAnswerVisible()
            return
          }
          setSubmitting(true)
          if (result.waitsForVerifiedDelivery) {
            // Why: remote acceptance can outlive the keystroke pacing window.
            // Keep the card until delivery is proven instead of cancelling the
            // inference callback at the old fixed dismissal deadline.
            return
          }
          // Hold the card until the paced write finishes, then mark it answered
          // (which hides it and restores the composer).
          dismissTimerRef.current = setTimeout(() => {
            cancelPending()
            dismissAnsweredCard(result.confirmAnswered, result.settleAfterMs)
          }, result.settleAfterMs)
        }}
        onCancel={() => {
          clearDismissTimer()
          // An explicit cancel (ESC) retires the question outright, so no
          // confirmation is owed and the card must not return.
          clearConfirmationWait()
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
