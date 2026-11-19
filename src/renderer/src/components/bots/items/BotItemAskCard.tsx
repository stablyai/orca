// The agent's open question on its item, in chat's own question card and where chat puts it: in place of
// the comment box, right under the item's Activity. It uses the open-question surface, so it
// can't be mistaken for the answered questions above it. Folding it gives the comment box back; a
// comment never answers it. The agent decides how many decisions and choices an ask has; the card draws
// what it wrote, several decisions as steps.
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { botRefKey } from '@/lib/bot-hosts'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import {
  botItemAnswerProblem,
  normalizeBotItemAnswers,
  botItemAnswersOf,
  botItemAskPrompt
} from '../../../../../shared/bots/bot-item-ask'
import type { AskAnswerSelection } from '../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import { NativeChatQuestionCard } from '../../native-chat/prompts/NativeChatQuestionCard'
import { botErrorMessage } from '../bot-presentation'
import {
  BOT_ITEM_OPEN_ASK_SURFACE,
  BotItemQuestionHeading,
  BotItemWaitingFlag
} from './BotItemAskLook'
import type { BotItemCommentBoxHandle } from './BotItemCommentBox'
import { BotItemClampedText } from './BotItemClampedText'
import { answerBotItem } from './use-bot-items'
import {
  botItemAnswerDraftKey,
  markBotItemAnswerDraft,
  readBotItemAnswerDraft,
  saveBotItemAnswerDraft
} from './bot-item-answer-drafts'
import { useClearOfFloatingTrigger } from './use-clear-of-floating-trigger'

const TIME = { hour: 'numeric', minute: '2-digit' } as const

export function BotItemAskCard({
  bot,
  item,
  question,
  askedAt,
  takeFocus,
  onCollapse,
  onReconcile,
  ref
}: {
  bot: Bot
  item: BotItem
  question: NonNullable<BotItem['question']>
  /** Reads the item again: what the host now holds settles a closed or unanswered send. */
  onReconcile: () => void
  /** When the agent asked, if its event is loaded. */
  askedAt: number | null
  takeFocus: boolean
  onCollapse: () => void
  ref?: Ref<BotItemCommentBoxHandle>
}): React.JSX.Element {
  const t = useTranslate()
  const ask = question.ask ?? null
  const prompt = useMemo(() => botItemAskPrompt(question.text, ask), [question.text, ask])
  const [submitting, setSubmitting] = useState(false)
  // Synchronous, so a double click sends once even before `submitting` renders.
  const inFlight = useRef(false)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  // Like the comment box, it rises clear of the floating terminal button.
  const lift = useClearOfFloatingTrigger(box)
  // The owner's picks and words live in the session's drafts, so a remount or the question going away
  // never drops them; the page offers back what the question took with it.
  const draftKey = botItemAnswerDraftKey(botRefKey(bot), item.uid, question.eventId)
  const [startFrom] = useState(() => readBotItemAnswerDraft(draftKey))
  const draft = useMemo(
    () => ({
      selections: startFrom?.selections ?? prompt.questions.map(() => []),
      otherText: startFrom?.otherText ?? prompt.questions.map(() => ''),
      onChange: (selections: number[][], otherText: string[]) =>
        saveBotItemAnswerDraft(draftKey, prompt, selections, otherText)
    }),
    [draftKey, prompt, startFrom]
  )

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    type: (text) => {
      const node = field.current
      if (!node) {
        return
      }
      node.focus()
      // Through the field's own editing, so React sees it as typed.
      document.execCommand('insertText', false, text)
    }
  }))

  const submit = (selections: AskAnswerSelection[]): void => {
    if (inFlight.current) {
      return
    }
    const answers = botItemAnswersOf(selections)
    const problem = botItemAnswerProblem(ask, answers)
    if (problem) {
      toast.error(problem)
      return
    }
    const existing = readBotItemAnswerDraft(draftKey)
    // Another mount of this card may still be sending it.
    if (existing?.sending) {
      return
    }
    // The same answer again reuses its id, so the host records it once; every id is kept with the
    // answer it first submitted (never replaced), so an answer under any of them reads as this
    // card's own.
    const key = JSON.stringify([question.eventId, normalizeBotItemAnswers(answers)])
    const sent =
      existing?.sent?.key === key ? existing.sent : { key, id: createNonSecureContextUuid() }
    const attempts = { [sent.id]: key, ...existing?.attempts }
    markBotItemAnswerDraft(draftKey, {
      sent,
      attempts,
      sending: true,
      uncertain: undefined,
      hostCannotRecord: undefined
    })
    inFlight.current = true
    setSubmitting(true)
    // Whatever the reply, busy ends with it and the item is read again: the card shows what the host
    // now holds, not what a change notice may or may not bring.
    const settle = (): void => {
      inFlight.current = false
      setSubmitting(false)
      markBotItemAnswerDraft(draftKey, { sending: undefined })
      onReconcile()
    }
    void answerBotItem(bot, item.uid, question.eventId, answers, sent.id)
      .then((outcome) => {
        if (outcome === 'answered') {
          markBotItemAnswerDraft(draftKey, { answeredId: sent.id })
        } else if (outcome === 'unsupported') {
          // An older host refused it and wrote nothing. Nothing else goes in its place: a plain comment
          // there answers whichever question is open when it lands, which may no longer be this one.
          markBotItemAnswerDraft(draftKey, { hostCannotRecord: true })
          onCollapse()
        } else {
          toast.info(
            t(
              'bots.items.ask.closed',
              'That question closed before your answer went. Your answer is kept on the item.'
            )
          )
        }
        settle()
      })
      .catch((error: unknown) => {
        // No reply: it may be recorded. The same answer again goes under the same id.
        markBotItemAnswerDraft(draftKey, { uncertain: true })
        settle()
        toast.error(botErrorMessage(error))
      })
  }

  const name = item.owner.name ?? bot.name
  return (
    <div
      ref={box}
      style={lift > 0 ? { marginBottom: lift } : undefined}
      data-bot-item-ask="open"
      // At most about half the pane, so the frozen top stays whole; the card scrolls inside that.
      className="flex max-h-[55%] min-h-0 shrink-0 flex-col"
    >
      <NativeChatQuestionCard
        key={question.eventId}
        prompt={prompt}
        draft={draft}
        isSubmitting={submitting}
        onAnswer={submit}
        onCollapse={onCollapse}
        shouldFocus={takeFocus}
        answerInputRef={field}
        look={{
          // The item's own cap replaces chat's, and the card shrinks to it.
          frameClassName:
            'max-h-none shrink bg-transparent [&>div]:px-3.5 [&>div]:pt-1 [&>div]:pb-3',
          surfaceClassName: BOT_ITEM_OPEN_ASK_SURFACE,
          stepsInSurface: true,
          renderQuestion: (content) => <BotItemQuestionHeading text={content} />,
          header: (
            <>
              <div className="flex min-w-0 items-center gap-2 px-3.5 pt-2.5">
                <BotItemWaitingFlag />
                <span className="ml-auto min-w-0 truncate text-2xs text-muted-foreground">
                  {askedAt === null
                    ? t('bots.items.ask.asks', '{{name}} asks', { name })
                    : t('bots.items.ask.asksAt', '{{name}} asks · {{time}}', {
                        name,
                        time: uiDateTimeFormat(TIME).format(askedAt)
                      })}
                </span>
              </div>
              {/* Off the loaded page, the agent's context isn't in Activity yet, so it shows here. */}
              {askedAt === null && ask?.context ? (
                <div className="px-3.5 pt-1.5 text-muted-foreground">
                  <BotItemClampedText text={ask.context} clampClassName="line-clamp-3" />
                </div>
              ) : null}
            </>
          )
        }}
      />
    </div>
  )
}
