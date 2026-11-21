// A Needs you comment's question footer: under the body, each question line (`--ask`) with its quick
// replies. While the item waits on it, the open line reads as a title and its recommended reply is
// filled; the card's Needs you tag carries the color.
// One question: a quick reply posts its words as the owner's comment, and Alt- or Shift-click puts them
// in the comment box to add to first; Type your answer leads to the box. Several: one line at a time
// (BotItemQuestionStep), answers held until they post. Answered, a line is muted with nothing of the
// answer, which is the owner's own card further down; a click leads there.
import { Pencil } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botItemQuickReplyText,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import { botItemAnswersComment } from '../../../../../shared/bots/bot-item-answer-lines'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemMarkdown } from './BotItemMarkdown'
import {
  BOT_ITEM_CHIP,
  BOT_ITEM_QUESTION_LINE_ATTRIBUTE,
  BotItemAnsweredQuestion,
  BotItemChipWords,
  BOT_ITEM_CHIP_RECOMMENDED,
  BOT_ITEM_OPEN_QUESTION,
  BotItemHeldQuestion,
  BotItemQuestionStep,
  botItemHeldWords
} from './BotItemQuestionStep'
import type { BotItemJumpTarget } from './bot-item-jump'
import { BOT_ITEM_CHIPS_ATTRIBUTE } from './use-bot-item-chip-stacked'
import type { BotItemQuickReplyActions } from './use-bot-item-question-steps'
import { holdBotItemAnswer, useBotItemHeldAnswers } from './bot-item-held-answers'

const NO_ANSWERS: readonly (BotItemEvent | null)[] = []
const NO_HELD_SCOPES: readonly string[] = []

export function BotItemQuestionLines({
  shape,
  askId,
  heldScopes = NO_HELD_SCOPES,
  waiting,
  answers = NO_ANSWERS,
  actions,
  onJump,
  className
}: {
  shape: BotItemQuestionShape
  /** The ask's event id. */
  askId: string
  /** Per line, where its answer held on this device lives, for an ask of several questions. */
  heldScopes?: readonly string[]
  /** The item waits on this question now. */
  waiting: boolean
  /** Per line, the owner comment that answered it. */
  answers?: readonly (BotItemEvent | null)[]
  /** While it waits, what its quick replies do; absent where the item takes no comment. */
  actions?: BotItemQuickReplyActions
  /** Leads from an answered line to its answer. */
  onJump?: (target: BotItemJumpTarget) => void
  /** Its spacing from the body above; by default a gap under a body. */
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const steps = actions?.steps?.askId === askId ? actions.steps : null
  const several = shape.decisions.length > 1
  // Answers held for an ask of an item closed since: each line's draft, until sent.
  const stored = useBotItemHeldAnswers(heldScopes)
  const spacing = className ?? (shape.body.trim() ? 'mt-4' : undefined)
  if (waiting && several && steps && actions) {
    return (
      <div data-bot-item-question="waiting" className={spacing}>
        <BotItemQuestionStep
          shape={shape}
          askId={askId}
          answers={answers}
          steps={steps}
          actions={actions}
          onJump={onJump}
        />
      </div>
    )
  }
  const unsent = waiting ? [] : stored
  return (
    <div data-bot-item-question={waiting ? 'waiting' : 'closed'} className={spacing}>
      <div className={several ? 'space-y-1.5' : 'space-y-3'}>
        {shape.decisions.map((decision, index) => {
          const answer = answers[index]
          // Each line waits until its own reply; the agent stops waiting when it asks again or the item closes.
          const open = waiting && !answer
          const held = unsent[index]
          const place = { [BOT_ITEM_QUESTION_LINE_ATTRIBUTE]: `${askId}:${index}` }
          if (answer) {
            return (
              <div key={decision.question} {...place} className="rounded-sm outline-none">
                <BotItemAnsweredQuestion
                  question={decision.question}
                  onClick={onJump ? () => onJump({ eventId: answer.id }) : undefined}
                />
              </div>
            )
          }
          if (held && actions) {
            return (
              <BotItemHeldQuestion
                key={decision.question}
                question={decision.question}
                words={botItemHeldWords(held)}
                // Not sent: into the box, to send as a comment.
                onClick={() => {
                  const { text, paths } = botItemAnswersComment(
                    shape,
                    shape.decisions.map((_, at) => (at === index ? held : null))
                  )
                  actions.recover(text, paths)
                  holdBotItemAnswer(heldScopes[index]!, null)
                }}
              />
            )
          }
          return (
            // A decision's question is unique within its ask.
            <div key={decision.question} {...place} className="rounded-sm outline-none">
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
                <div
                  {...{ [BOT_ITEM_CHIPS_ATTRIBUTE]: '' }}
                  className="mt-2.5 flex flex-wrap gap-2"
                >
                  {decision.replies.map((reply) => (
                    <button
                      key={reply.label}
                      type="button"
                      title={reply.detail}
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
                      <BotItemChipWords reply={reply} filled={reply.recommended} />
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
    </div>
  )
}
