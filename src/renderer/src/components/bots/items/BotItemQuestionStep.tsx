// The waiting ask of several questions, one line at a time: the lines answered so far fold above as
// "Question → answer" (a held one reopens on click), then the open line with ‹ 2 of 4 › and its quick
// replies. A quick reply answers the line and the step moves on; Type your answer leads to the box,
// whose Enter answers the same line.
import { Check, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botItemQuestionLine,
  type BotItemQuestionShape,
  type BotItemQuickReply
} from '../../../../../shared/bots/bot-item-ask'
import { BotItemMarkdown } from './BotItemMarkdown'
import type { BotItemQuestionSteps, BotItemQuickReplyActions } from './use-bot-item-question-steps'

export const BOT_ITEM_CHIP =
  'min-h-8 max-w-full rounded-2xl border border-question-option-border px-3.5 py-1.5 text-left text-[13px] leading-[18px]'

const CHIP_ACTION =
  'outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50'

/** The picked reply of a line reopened. */
const CHIP_PICKED = 'flex items-center gap-1.5 border-foreground/28 bg-foreground/8 text-foreground'

export function BotItemChipWords({ reply }: { reply: BotItemQuickReply }): React.JSX.Element {
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

/** The open line's mark: hangs in the gutter, so the question, the body and the chips share one left edge. */
export function BotItemQuestionDot(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="absolute -left-3 top-[6.5px] size-1.5 rounded-full bg-agent-question"
    />
  )
}

/** "Question → answer", muted: an answered line, or one held on this device ("not sent yet") that
 *  reopens on click. */
export function BotItemAnswerLine({
  question,
  words,
  onClick
}: {
  question: string
  words: string
  onClick?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const content = (
    <>
      {botItemQuestionLine(question)} →{' '}
      <span className="text-foreground/72 [overflow-wrap:anywhere]">{words}</span>
      {onClick ? <> · {t('bots.items.ask.notSentYet', 'not sent yet')}</> : null}
    </>
  )
  const line = 'block w-full text-left text-[13px] leading-[19px] text-muted-foreground'
  return onClick ? (
    <button
      type="button"
      className={cn(
        line,
        'rounded-sm outline-none hover:[&>span]:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <p className={cn(line, 'whitespace-pre-line')}>{content}</p>
  )
}

function StepNav({ steps }: { steps: BotItemQuestionSteps }): React.JSX.Element {
  const t = useTranslate()
  const at = steps.lines.indexOf(steps.current)
  const button =
    'flex size-6 items-center justify-center rounded-md outline-none hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-35'
  return (
    <span className="-my-[2.5px] -mr-1 flex shrink-0 items-center whitespace-nowrap text-2xs leading-6 text-muted-foreground tabular-nums">
      <button
        type="button"
        aria-label={t('bots.items.ask.previous', 'Previous question')}
        className={button}
        disabled={at <= 0}
        onClick={() => steps.go(steps.lines[at - 1]!)}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="px-0.5">
        {t('bots.items.ask.step', '{{n}} of {{total}}', { n: at + 1, total: steps.lines.length })}
      </span>
      <button
        type="button"
        aria-label={t('bots.items.ask.next', 'Next question')}
        className={button}
        disabled={at >= steps.lines.length - 1}
        onClick={() => steps.go(steps.lines[at + 1]!)}
      >
        <ChevronRight className="size-3.5" />
      </button>
    </span>
  )
}

export function BotItemQuestionStep({
  shape,
  answered,
  steps,
  actions
}: {
  shape: BotItemQuestionShape
  /** Per line, the words a posted comment answered it with. */
  answered: readonly (string | null)[]
  steps: BotItemQuestionSteps
  actions: BotItemQuickReplyActions
}): React.JSX.Element {
  const t = useTranslate()
  const { current } = steps
  const decision = shape.decisions[current]!
  const held = steps.held[current] ?? null
  const typed = held !== null && !decision.replies.some((reply) => reply.label === held)
  const folded = shape.decisions.flatMap((line, index) => {
    const words = index === current ? null : (answered[index] ?? steps.held[index])
    return words ? [{ line, index, words, reopens: !answered[index] }] : []
  })
  return (
    <>
      {folded.length > 0 ? (
        <div className="mb-3 flex flex-col gap-1">
          {folded.map(({ line, index, words, reopens }) => (
            <BotItemAnswerLine
              key={line.question}
              question={line.question}
              words={words}
              onClick={reopens ? () => steps.go(index) : undefined}
            />
          ))}
        </div>
      ) : null}
      {/* Keyed by the line: each step fades in where the last one was. */}
      <div
        key={current}
        className="duration-[180ms] animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none"
      >
        <div className="flex items-start gap-2">
          <div className="relative min-w-0 flex-1 font-medium [&_p]:font-medium">
            <BotItemQuestionDot />
            <BotItemMarkdown text={decision.question} />
          </div>
          <StepNav steps={steps} />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {decision.replies.map((reply) => {
            const picked = held === reply.label
            return (
              <button
                key={reply.label}
                type="button"
                title={reply.detail}
                aria-pressed={picked}
                className={cn(BOT_ITEM_CHIP, CHIP_ACTION, picked ? CHIP_PICKED : 'text-foreground')}
                onClick={(event) => {
                  if (event.altKey || event.shiftKey) {
                    actions.edit(reply.label)
                  } else {
                    steps.answer(current, reply.label)
                  }
                }}
              >
                {picked ? <Check className="size-3 shrink-0" /> : null}
                <span className="min-w-0">
                  <BotItemChipWords reply={reply} />
                </span>
              </button>
            )
          })}
          {typed ? (
            // Your words for this line: back into the box to change them.
            <button
              type="button"
              className={cn(BOT_ITEM_CHIP, CHIP_ACTION, CHIP_PICKED)}
              onClick={() => actions.edit(held)}
            >
              <Pencil className="size-3 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{held}</span>
            </button>
          ) : (
            <button
              type="button"
              className={cn(
                BOT_ITEM_CHIP,
                CHIP_ACTION,
                'flex items-center gap-1.5 text-muted-foreground'
              )}
              onClick={actions.type}
            >
              <Pencil className="size-3 shrink-0" />
              {t('bots.items.ask.typeAnswer', 'Type your answer')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
