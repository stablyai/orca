import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

/**
 * Render one prompt occurrence the view chose (see useNativeChatPromptCardPresentation): a
 * question wizard or a tool approval, in the composer's place. Sends through the composer's
 * verified runtime path (R8/R6): answers via agent-specific paste or selector keystrokes;
 * cancel/deny as ESC. Unmount cancels scheduled writes and ignores late results; writes already
 * issued to the transport cannot be recalled.
 *
 * The card hides (`onDismiss`) only once its answer was delivered: a refused or unconfirmed
 * answer keeps the choices up, so the user can answer again here or in the terminal.
 */
export function NativeChatInteractiveCard({
  card,
  send,
  onDismiss,
  onCollapse,
  shouldFocus = false,
  answerInputRef
}: {
  card: NonNullable<InteractivePromptCard>
  send: NativeChatInteractiveSend
  /** Hide this occurrence after its answer write was acknowledged. */
  onDismiss: () => void
  /** Fold this occurrence to a strip above the composer, writing nothing. */
  onCollapse?: () => void
  /** Take focus when the card takes the input region from the composer. */
  shouldFocus?: boolean
  /** Forwarded to the question card's free-text row so pane-level Paste keeps
   *  a target while the composer is unmounted. */
  answerInputRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const { sendAnswer, sendRawVerified, cancelPending, cancelAsk } = send
  // A question answer is a paced multi-step write (body→Enter per question); keep
  // the card up until it settles instead of dismissing on the click, so it doesn't
  // vanish mid-send. `submitting` also gates a second submit racing the first.
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const activeRef = useRef(true)
  const attemptRef = useRef(0)
  const cancellingRef = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const settle = useCallback((): void => {
    submittingRef.current = false
    setSubmitting(false)
    cancellingRef.current = false
    setCancelling(false)
  }, [])
  // Retire callbacks during commit; an already-issued write may still settle later.
  useLayoutEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      attemptRef.current += 1
      cancelPending()
    }
  }, [cancelPending])

  if (card.kind === 'question') {
    return (
      <NativeChatQuestionCard
        prompt={card.prompt}
        isSubmitting={submitting}
        isCancelling={cancelling}
        answerInputRef={answerInputRef}
        onAnswer={(selections) => {
          if (submittingRef.current) {
            return
          }
          submittingRef.current = true
          const attempt = ++attemptRef.current
          const result = sendAnswer(card.prompt, selections, (delivered) => {
            if (!activeRef.current || attempt !== attemptRef.current) {
              return
            }
            settle()
            if (delivered) {
              onDismiss()
            }
          })
          if (result.settleAfterMs <= 0) {
            // Keep the actionable card visible when its PTY disappeared between
            // render and submit; the next live target update can make it retryable.
            settle()
            return
          }
          setSubmitting(true)
        }}
        onCollapse={onCollapse}
        shouldFocus={shouldFocus}
        onCancel={() => {
          if (cancellingRef.current) {
            return
          }
          settle()
          const attempt = ++attemptRef.current
          cancellingRef.current = true
          setCancelling(true)
          submittingRef.current = true
          setSubmitting(true)
          void cancelAsk()
            .catch(() => false)
            .then((delivered) => {
              if (!activeRef.current || attempt !== attemptRef.current) {
                return
              }
              settle()
              if (delivered) {
                onDismiss()
              }
            })
        }}
      />
    )
  }
  const choose = (raw: string): void => {
    if (submittingRef.current) {
      return
    }
    submittingRef.current = true
    const attempt = ++attemptRef.current
    setSubmitting(true)
    void sendRawVerified(raw)
      .catch(() => false)
      .then((delivered) => {
        if (!activeRef.current || attempt !== attemptRef.current) {
          return
        }
        settle()
        if (delivered) {
          onDismiss()
        }
      })
  }
  return (
    <NativeChatApprovalCard
      approval={card.approval}
      shouldFocus={shouldFocus}
      isSubmitting={submitting}
      onChoose={choose}
      onCollapse={onCollapse}
    />
  )
}
