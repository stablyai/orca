import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** Dismiss only after acknowledged delivery; unmount cancels scheduled writes and ignores late results, but cannot recall issued writes. */
export function NativeChatInteractiveCard({
  card,
  send,
  onDismiss,
  onCollapse,
  requiresTerminal = false,
  onAnswerInTerminal,
  shouldFocus = false,
  answerInputRef
}: {
  card: NonNullable<InteractivePromptCard>
  send: NativeChatInteractiveSend
  /** Hide this occurrence after its answer write was acknowledged. */
  onDismiss: () => void
  /** Fold this occurrence to a strip above the composer, writing nothing. */
  onCollapse?: () => void
  requiresTerminal?: boolean
  onAnswerInTerminal?: () => void
  /** Take focus when the card takes the input region from the composer. */
  shouldFocus?: boolean
  /** Paste target while the prompt card replaces the composer. */
  answerInputRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const { sendAnswer, sendRawVerified, cancelPending, cancelAsk } = send
  // Keep paced multi-step answers visible until delivery settles; block duplicate submissions meanwhile.
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
    if (requiresTerminal) {
      return (
        <div className="shrink-0 bg-chat-canvas">
          <div className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-4 sm:px-4">
            <div className="rounded-lg border border-input bg-card p-3 shadow-xs">
              <p className="text-sm text-foreground">
                {translate(
                  'components.native-chat.question.terminalRequired',
                  'Answer this OMP question in the terminal.'
                )}
              </p>
              <Button
                className="mt-3"
                size="sm"
                disabled={!onAnswerInTerminal}
                onClick={onAnswerInTerminal}
              >
                {translate('components.native-chat.question.openTerminal', 'Answer in terminal')}
              </Button>
            </div>
          </div>
        </div>
      )
    }
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
            // Keep the card retryable if its PTY disappeared before submission.
            settle()
            return
          }
          setSubmitting(true)
        }}
        onCollapse={onCollapse}
        shouldFocus={shouldFocus}
        onCancel={() => {
          if (card.prompt.replyAsMessage) {
            // The agent is not waiting on this card, and Escape would interrupt its turn.
            onDismiss()
            return
          }
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
