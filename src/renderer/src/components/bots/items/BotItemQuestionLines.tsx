// A Needs you comment's question footer: under the body, each question line (`--ask`)
// with its quick replies. While the item waits on it, an orange dot marks each line, the one color on
// the comment; a quick reply posts its words as the owner's comment, and Alt- or Shift-click puts them
// in the comment box to add to first; Type your answer leads to the box. Answered, the lines go muted and keep only the reply picked.
import { Check, Pencil } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botItemPickedReplies,
  botItemQuickReplyText,
  type BotItemQuestionShape,
  type BotItemQuickReply
} from '../../../../../shared/bots/bot-item-ask'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemMarkdown } from './BotItemMarkdown'

export type BotItemQuickReplyActions = {
  send: (text: string) => void
  edit: (text: string) => void
  /** Type your answer: the comment box takes focus, glowing once. */
  type: () => void
}

const CHIP =
  'min-h-8 max-w-full rounded-2xl border border-question-option-border px-3.5 py-1.5 text-left text-[13px] leading-[18px]'

function ChipWords({ reply }: { reply: BotItemQuickReply }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {reply.label}
      {reply.recommended ? (
        <span className="ml-1.5 whitespace-nowrap text-2xs text-muted-foreground">
          {t('bots.items.ask.recommended', 'Recommended')}
        </span>
      ) : null}
    </>
  )
}

const NO_ANSWERS: readonly (BotItemEvent | null)[] = []

export function BotItemQuestionLines({
  shape,
  waiting,
  answers = NO_ANSWERS,
  actions
}: {
  shape: BotItemQuestionShape
  /** The item waits on this question now. */
  waiting: boolean
  /** Per line, the owner comment that answered it: that line closes and keeps only its pick. */
  answers?: readonly (BotItemEvent | null)[]
  /** While it waits, what its quick replies do; absent where the item takes no comment. */
  actions?: BotItemQuickReplyActions
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      data-bot-item-question={waiting ? 'waiting' : 'closed'}
      className={cn(shape.body.trim() && 'mt-4')}
    >
      <div className="space-y-3">
        {shape.decisions.map((decision, index) => {
          const answer = answers[index] ?? null
          // Each line waits until its own reply; the agent stops waiting when it asks again or the item closes.
          const open = waiting && !answer
          const picks = answer ? (botItemPickedReplies(shape, answer.data)[index] ?? []) : []
          return (
            // A decision's question is unique within its ask.
            <div key={decision.question}>
              <div
                className={cn(
                  'relative font-medium [&_p]:font-medium',
                  !open && 'text-muted-foreground [&_*]:text-muted-foreground'
                )}
              >
                {open ? (
                  // Hangs in the gutter, so the question, the body and the chips share one left edge.
                  <span
                    aria-hidden
                    className="absolute -left-3 top-[6.5px] size-1.5 rounded-full bg-agent-question"
                  />
                ) : null}
                <BotItemMarkdown text={decision.question} />
              </div>
              {open && actions && decision.replies.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {decision.replies.map((reply) => (
                    <button
                      key={reply.label}
                      type="button"
                      title={reply.detail}
                      className={cn(
                        CHIP,
                        'text-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50'
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
                      <ChipWords reply={reply} />
                    </button>
                  ))}
                  {/* Muted, with a pencil: your own words are the other way to answer. */}
                  <button
                    type="button"
                    className={cn(
                      CHIP,
                      'flex items-center gap-1.5 text-muted-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50'
                    )}
                    onClick={actions.type}
                  >
                    <Pencil className="size-3 shrink-0" />
                    {t('bots.items.ask.typeAnswer', 'Type your answer')}
                  </button>
                </div>
              ) : picks.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {picks.map((pick) => (
                    <span
                      key={pick.label}
                      className={cn(
                        CHIP,
                        'flex items-center gap-1.5 bg-foreground/5 text-muted-foreground'
                      )}
                    >
                      <Check className="size-3 shrink-0" />
                      <span className="min-w-0">
                        <ChipWords reply={pick} />
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
