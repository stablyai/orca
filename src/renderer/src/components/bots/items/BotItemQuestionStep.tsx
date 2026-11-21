// The waiting ask of several questions, one line at a time: the lines answered so far fold above, muted
// (one sent leads to your answer; one held here, "not sent yet", reopens on click), then the open line
// with ‹ 2 of 4 › and its quick replies. A quick reply answers the line and the step moves on; Type
// your answer leads to the box, whose Enter answers the same line. The held answers show in your own
// card at the end of Activity.
import { Check, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { buttonVariants } from '@/components/ui/button'
import {
  botItemQuestionLine,
  type BotItemQuestionShape,
  type BotItemQuickReply
} from '../../../../../shared/bots/bot-item-ask'
import type { BotItemHeldAnswer } from '../../../../../shared/bots/bot-item-answer-lines'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { stripSentImagePromptMarkers } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { BotItemMarkdown } from './BotItemMarkdown'
import type { BotItemJumpTarget } from './bot-item-jump'
import type { BotItemQuestionSteps, BotItemQuickReplyActions } from './use-bot-item-question-steps'
import { BOT_ITEM_CHIPS_ATTRIBUTE, useBotItemChipStacked } from './use-bot-item-chip-stacked'

export const BOT_ITEM_CHIP =
  'min-h-8 w-fit max-w-full rounded-2xl border border-question-option-border px-3.5 py-1.5 text-left text-[13px] leading-[18px]'

const CHIP_ACTION =
  'outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50'

/** The recommended reply of an open line: filled, the one the owner most likely means. */
export const BOT_ITEM_CHIP_RECOMMENDED = buttonVariants({
  variant: 'default',
  className: cn(
    BOT_ITEM_CHIP,
    'h-auto justify-start gap-0 whitespace-normal border-foreground bg-foreground font-normal text-background hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring/50'
  )
})

/** An open question's words: a title, 14 px semibold, over the Markdown's own 13 px. */
export const BOT_ITEM_OPEN_QUESTION =
  'font-semibold [&_p]:font-semibold [&>*]:text-sm [&>*]:leading-5'

/** The picked reply of a line reopened. */
const CHIP_PICKED = 'flex items-center gap-1.5 border-foreground/28 bg-foreground/8 text-foreground'

export function BotItemChipWords({
  reply,
  filled = false
}: {
  reply: BotItemQuickReply
  /** The filled recommended chip: Recommended reads on the fill, under the label when both don't fit. */
  filled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const recommended = t('bots.items.ask.recommended', 'Recommended')
  const { root, label, tag, stacked } = useBotItemChipStacked(filled, recommended)
  if (filled) {
    return (
      <span
        ref={root}
        className={cn(
          'max-w-full items-baseline',
          stacked ? 'flex flex-col items-start' : 'inline-flex'
        )}
      >
        <span ref={label} className="min-w-0 [overflow-wrap:anywhere]">
          {reply.label}
        </span>
        <span
          ref={tag}
          className={cn(
            'shrink-0 whitespace-nowrap text-2xs text-background/70',
            !stacked && 'ml-1.5'
          )}
        >
          {recommended}
        </span>
      </span>
    )
  }
  return (
    <>
      {reply.label}
      {reply.recommended ? (
        <span className="ml-1.5 whitespace-nowrap text-2xs text-muted-foreground">
          {recommended}
        </span>
      ) : null}
    </>
  )
}

/** Where a jump from an answer lands: the ask's line, by `${askId}:${index}`. */
export const BOT_ITEM_QUESTION_LINE_ATTRIBUTE = 'data-bot-item-question-line'

/** An answered line, muted, with nothing of the answer: a click leads to the answer's own card. */
export function BotItemAnsweredQuestion({
  question,
  place,
  onClick
}: {
  question: string
  /** The line's `${askId}:${index}`, where it is a jump's target itself. */
  place?: string
  onClick?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      {...(place ? { [BOT_ITEM_QUESTION_LINE_ATTRIBUTE]: place } : {})}
      title={t('bots.items.ask.goToAnswer', 'Go to your answer')}
      disabled={!onClick}
      className="block w-full rounded-sm text-left text-[13px] leading-[19px] font-medium text-muted-foreground outline-none [overflow-wrap:anywhere] hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:hover:text-muted-foreground"
      onClick={onClick}
    >
      {botItemQuestionLine(question)}
    </button>
  )
}

/** A line answered on this device, not sent yet: "Question · not sent yet", or with the answer's
 *  words where no card of yours shows them (held for an ask the agent no longer waits on). A click
 *  reopens it. */
export function BotItemHeldQuestion({
  question,
  words,
  place,
  onClick
}: {
  question: string
  words?: string
  /** The line's `${askId}:${index}`, where it is a jump's target itself. */
  place?: string
  onClick: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      {...(place ? { [BOT_ITEM_QUESTION_LINE_ATTRIBUTE]: place } : {})}
      title={t('bots.items.ask.changeAnswer', 'Change this answer')}
      className="block w-full rounded-sm text-left text-[13px] leading-[19px] text-muted-foreground outline-none [overflow-wrap:anywhere] hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={onClick}
    >
      {botItemQuestionLine(question)}
      {words ? (
        <>
          {' '}
          → <span className="text-foreground/72">{words}</span>
        </>
      ) : null}{' '}
      · {t('bots.items.ask.notSentYet', 'not sent yet')}
    </button>
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
  askId,
  answers,
  steps,
  actions,
  onJump
}: {
  shape: BotItemQuestionShape
  askId: string
  /** Per line, the owner comment that answered it. */
  answers: readonly (BotItemEvent | null)[]
  steps: BotItemQuestionSteps
  actions: BotItemQuickReplyActions
  onJump?: (target: BotItemJumpTarget) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { current } = steps
  const decision = shape.decisions[current]!
  const held = steps.held[current] ?? null
  const typed = held !== null && !decision.replies.some((reply) => reply.label === held.words)
  const folded = shape.decisions.flatMap((line, index) => {
    if (index === current) {
      return []
    }
    const answer = steps.lines.includes(index) ? null : answers[index]
    if (answer) {
      return [
        <BotItemAnsweredQuestion
          key={line.question}
          question={line.question}
          place={`${askId}:${index}`}
          onClick={onJump ? () => onJump({ eventId: answer.id }) : undefined}
        />
      ]
    }
    return steps.held[index]
      ? [
          <BotItemHeldQuestion
            key={line.question}
            question={line.question}
            place={`${askId}:${index}`}
            onClick={() => steps.edit(index)}
          />
        ]
      : []
  })
  return (
    <>
      {folded.length > 0 ? <div className="mb-3 flex flex-col gap-1.5">{folded}</div> : null}
      {/* Keyed by the line: each step fades in where the last one was. */}
      <div
        key={current}
        {...{ [BOT_ITEM_QUESTION_LINE_ATTRIBUTE]: `${askId}:${current}` }}
        className="rounded-sm duration-[180ms] animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none"
      >
        <div className="flex items-start gap-2">
          <div className={cn('min-w-0 flex-1', BOT_ITEM_OPEN_QUESTION)}>
            <BotItemMarkdown text={decision.question} />
          </div>
          {/* The last open line has nowhere to step. */}
          {steps.lines.length > 1 ? <StepNav steps={steps} /> : null}
        </div>
        <div {...{ [BOT_ITEM_CHIPS_ATTRIBUTE]: '' }} className="mt-2.5 flex flex-wrap gap-2">
          {decision.replies.map((reply) => {
            const picked = held?.words === reply.label
            // Filled until the owner picks one on this line; then the pick stands out instead.
            const filled = reply.recommended && held === null
            return (
              <button
                key={reply.label}
                type="button"
                title={reply.detail}
                aria-pressed={picked}
                className={cn(
                  BOT_ITEM_CHIP,
                  CHIP_ACTION,
                  picked ? CHIP_PICKED : filled ? BOT_ITEM_CHIP_RECOMMENDED : 'text-foreground'
                )}
                onClick={(event) => {
                  if (event.altKey || event.shiftKey) {
                    actions.edit(reply.label)
                  } else {
                    steps.answer(current, reply.label)
                  }
                }}
              >
                {picked ? <Check className="size-3 shrink-0" /> : null}
                <span className="min-w-0 max-w-full">
                  <BotItemChipWords reply={reply} filled={filled} />
                </span>
              </button>
            )
          })}
          {typed ? (
            // Your words for this line: back into the box, its images too, to change them.
            <button
              type="button"
              className={cn(BOT_ITEM_CHIP, CHIP_ACTION, CHIP_PICKED)}
              onClick={() => steps.edit(current)}
            >
              <Pencil className="size-3 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {botItemHeldWords(held) || held.paths[0]?.split(/[\\/]/).pop()}
              </span>
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

/** A held answer's words as they read, without the [Image #N] of its images. */
export function botItemHeldWords(held: BotItemHeldAnswer): string {
  return stripSentImagePromptMarkers(held.words, held.paths.length).trim()
}
