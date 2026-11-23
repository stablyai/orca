// A Needs you comment's question footer: under the body, each question line (`--ask`) with its quick
// replies. While the item waits on it, the open line reads as a title and its recommended reply is
// filled; the card's Needs you tag carries the color.
// One question: a quick reply posts its words as the owner's comment, and Alt- or Shift-click puts them
// in the comment box to add to first; Type your answer leads to the box. Several: every line at once
// (BotItemQuestionStep), picks held until Send. Answered, a line reads "Question → answer", muted,
// and the answer's own card is not drawn again.
import { Pencil } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botItemQuickReplyText,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import {
  botItemAnswersText,
  botItemAnswerWords,
  botItemUnsentAnswers
} from '../../../../../shared/bots/bot-item-answer-lines'
import type { BotItemAskEnd } from '../../../../../shared/bots/bot-item-question-answers'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemMarkdown } from './BotItemMarkdown'
import {
  BOT_ITEM_CHIP,
  BotItemAnswerLine,
  BotItemChipWords,
  botItemChipTitle,
  BOT_ITEM_CHIP_RECOMMENDED,
  BOT_ITEM_OPEN_QUESTION,
  BotItemQuestionStep
} from './BotItemQuestionStep'
import { useBotItemHeldAnswers } from './bot-item-held-answers'
import type { BotItemQuickReplyActions } from './use-bot-item-question-steps'

const NO_ANSWERS: readonly (BotItemEvent | null)[] = []
const NO_HELD_SCOPE = 'bot-item-answers:none'

export function BotItemQuestionLines({
  shape,
  askId,
  heldScope,
  waiting,
  answers = NO_ANSWERS,
  byOrder,
  ended = null,
  actions,
  className
}: {
  shape: BotItemQuestionShape
  /** The ask's event id. */
  askId: string
  /** Where this ask's held answers live on this device, for an ask of several questions. */
  heldScope?: string
  /** The item waits on this question now. */
  waiting: boolean
  /** Per line, the owner comment that answered it. */
  answers?: readonly (BotItemEvent | null)[]
  /** Per line, answered only by a comment naming no line: that comment shows as itself. */
  byOrder?: readonly boolean[]
  /** Why its open lines take no answer: a later ask replaced them, or the owner skipped them. */
  ended?: BotItemAskEnd | null
  /** While it waits, what its quick replies do; absent where the item takes no comment. */
  actions?: BotItemQuickReplyActions
  /** Its spacing from the body above; by default a gap under a body. */
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const recommended = t('bots.items.ask.recommended', 'Recommended')
  const steps = actions?.steps?.askId === askId ? actions.steps : null
  const several = shape.decisions.length > 1
  // Answers held for an ask the agent no longer waits on (it asked again): its draft, until sent.
  const stored = useBotItemHeldAnswers(heldScope ?? NO_HELD_SCOPE, shape)
  // Its sends on their way: shown on their lines until the host's read has them.
  const sent = actions?.sent?.get(askId) ?? null
  const answered = shape.decisions.map((_, index) => {
    // A line being stepped shows its held answer; with several questions, a comment that named no
    // line shows as itself, not as the line's answer.
    const answer =
      steps?.lines.includes(index) || (several && byOrder?.[index]) ? null : answers[index]
    return answer ? botItemAnswerWords(shape, index, answer.data) : (sent?.[index] ?? null)
  })
  const spacing = className ?? (shape.body.trim() ? 'mt-4' : undefined)
  if (waiting && several && steps && actions) {
    return (
      <div data-bot-item-question="waiting" className={spacing}>
        <BotItemQuestionStep shape={shape} answered={answered} steps={steps} actions={actions} />
      </div>
    )
  }
  // A line answered meanwhile shows its answer; its held one is not put back in the box.
  const unsentHeld = botItemUnsentAnswers(stored.held, answered)
  const unsent = !waiting && heldScope && unsentHeld.some(Boolean) ? unsentHeld : null
  return (
    <div data-bot-item-question={waiting ? 'waiting' : 'closed'} className={spacing}>
      <div className={several ? 'space-y-1.5' : 'space-y-3'}>
        {shape.decisions.map((decision, index) => {
          const words = answered[index]
          // Each line waits until its own reply; the agent stops waiting when it asks again or the item closes.
          const open = waiting && !answers[index] && !words
          const held = unsent?.[index]
          if (words) {
            return (
              <BotItemAnswerLine
                key={decision.question}
                question={decision.question}
                words={words}
              />
            )
          }
          if (held && actions && unsent) {
            return (
              <BotItemAnswerLine
                key={decision.question}
                question={decision.question}
                words={held}
                // Not sent: into the box, to send as a comment.
                onClick={() => {
                  actions.recover(botItemAnswersText(shape, unsent))
                  stored.hold([])
                }}
              />
            )
          }
          return (
            // A decision's question is unique within its ask.
            <div key={decision.question}>
              <div
                className={cn(
                  open
                    ? BOT_ITEM_OPEN_QUESTION
                    : 'font-medium text-muted-foreground [&_*]:text-muted-foreground [&_p]:font-medium'
                )}
              >
                <BotItemMarkdown text={decision.question} />
              </div>
              {open && actions && decision.replies.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {decision.replies.map((reply) => (
                    <button
                      key={reply.label}
                      type="button"
                      title={botItemChipTitle(reply, recommended)}
                      className={cn(
                        BOT_ITEM_CHIP,
                        'outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        reply.recommended
                          ? BOT_ITEM_CHIP_RECOMMENDED
                          : 'text-foreground hover:bg-foreground/5'
                      )}
                      onClick={(event) => {
                        const text = botItemQuickReplyText(shape, decision, reply)
                        if (event.altKey || event.shiftKey) {
                          actions.edit(text)
                        } else {
                          actions.send(text)
                        }
                      }}
                    >
                      <BotItemChipWords reply={reply} />
                    </button>
                  ))}
                  {/* Muted, with a pencil: your own words are the other way to answer. */}
                  <button
                    type="button"
                    className={cn(
                      BOT_ITEM_CHIP,
                      'flex items-center gap-1.5 text-muted-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50'
                    )}
                    onClick={actions.type}
                  >
                    <Pencil className="size-3 shrink-0" />
                    {t('bots.items.ask.typeAnswer', 'Type your answer')}
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {ended && answered.some((words, index) => !words && !unsent?.[index]) ? (
        <div className="mt-1.5 text-xs text-muted-foreground">
          {ended === 'skipped'
            ? t('bots.items.ask.skipped', 'Skipped')
            : t('bots.items.ask.replacedByNewer', 'Replaced by a newer question')}
        </div>
      ) : null}
    </div>
  )
}
