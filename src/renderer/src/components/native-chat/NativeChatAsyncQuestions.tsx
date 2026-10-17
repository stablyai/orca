import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatAsyncQuestion } from '../../../../shared/native-chat-types'
import {
  asyncQuestionsPrompt,
  formatAsyncQuestionAnswer
} from '../../../../shared/native-chat-async-questions'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NativeChatAsyncQuestionContext } from './native-chat-async-question-context'

/** Sends answers as chat messages and keeps drafts when folded or when delivery fails. */
export function NativeChatAsyncQuestions({
  questions
}: {
  questions: NativeChatAsyncQuestion[]
}): React.JSX.Element | null {
  const reply = useContext(NativeChatAsyncQuestionContext)
  const [expanded, setExpanded] = useState(true)
  const current = useRef<{ reply: typeof reply; expanded: boolean } | null>(null)
  useLayoutEffect(() => {
    current.current = { reply, expanded }
    return () => {
      current.current = null
    }
  }, [reply, expanded])
  const [sending, setSending] = useState(false)
  const inFlight = useRef(false)
  const card = useRef<HTMLFieldSetElement>(null)
  const replyButton = useRef<HTMLButtonElement>(null)
  const answerInput = useRef<HTMLInputElement>(null)
  if (!reply || questions.length === 0) {
    return null
  }
  /** Restores focus for card actions, but lets delayed sends leave the composer focused. */
  const collapse = (restoreFocus = true): void => {
    setExpanded(false)
    if (restoreFocus) {
      requestAnimationFrame(() => replyButton.current?.focus())
    }
  }
  return (
    <>
      <fieldset ref={card} hidden={!expanded} disabled={reply.disabled || sending || !expanded}>
        <NativeChatQuestionCard
          prompt={asyncQuestionsPrompt(questions)}
          isSubmitting={sending}
          allowOther
          answerInputRef={answerInput}
          onCancel={collapse}
          onCollapse={collapse}
          onAnswer={(selections) => {
            // A single-select choice runs after a delay; use the current input owner.
            const active = current.current
            if (!active?.reply || active.reply.disabled || !active.expanded || inFlight.current) {
              return
            }
            const text = formatAsyncQuestionAnswer(questions, selections)
            if (!text) {
              return
            }
            const result = active.reply.send(text)
            if (typeof result === 'boolean') {
              if (result) {
                collapse(card.current?.contains(document.activeElement) === true)
              }
              return
            }
            inFlight.current = true
            setSending(true)
            void result
              .then((accepted) => {
                if (accepted) {
                  collapse(card.current?.contains(document.activeElement) === true)
                }
              })
              .catch(() => false)
              .finally(() => {
                inFlight.current = false
                setSending(false)
              })
          }}
        />
      </fieldset>
      <div hidden={expanded} className="space-y-2">
        <p className="whitespace-pre-wrap text-sm">
          {questions.map((question) => question.title).join('\n\n')}
        </p>
        <Button
          ref={replyButton}
          variant="outline"
          size="sm"
          disabled={reply.disabled}
          onClick={() => {
            setExpanded(true)
            requestAnimationFrame(() => answerInput.current?.focus())
          }}
        >
          {translate('components.native-chat.question.reply', 'Reply')}
        </Button>
      </div>
    </>
  )
}
