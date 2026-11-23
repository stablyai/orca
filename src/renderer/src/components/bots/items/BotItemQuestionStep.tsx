// The waiting ask of several questions, every open line at once, a hairline between them. A quick reply
// picks the line's answer (solid, with a check) and folds it to "✓ Question… → answer", which reopens
// on click; nothing posts until Send, which posts the picks as one comment. A line answered, or sent
// and on its way, folds the same and stays. The comment box below is the one place to type: its
// Enter holds the words as the answer of the line its "Replying to" names, like a pick.
import { Check, LoaderCircle, Pencil } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botItemQuestionLine,
  type BotItemQuestionShape,
  type BotItemQuickReply
} from '../../../../../shared/bots/bot-item-ask'
import { BotItemMarkdown } from './BotItemMarkdown'
import type { BotItemQuestionSteps, BotItemQuickReplyActions } from './use-bot-item-question-steps'

// Half the single-line height: one line reads as a pill, a wrapped label as a rounded rectangle. Any
// label breaks inside the chip, an unbroken one too.
export const BOT_ITEM_CHIP =
  'min-h-8 w-fit max-w-full rounded-[16px] border border-question-option-border px-3.5 py-1.5 text-left text-[13px] leading-[18px] [overflow-wrap:anywhere]'

const CHIP_ACTION =
  'outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50'

/** The recommended reply of an open line: the same pill as its siblings, filled; the one the owner
 *  most likely means. */
export const BOT_ITEM_CHIP_RECOMMENDED =
  'border-foreground bg-foreground text-background hover:bg-foreground/90'

/** An open question's words: a title, 14 px semibold, over the Markdown's own 13 px. */
export const BOT_ITEM_OPEN_QUESTION =
  'font-semibold [&_p]:font-semibold [&>*]:text-sm [&>*]:leading-5'

/** A line's pick: solid, with a check. */
const CHIP_PICKED =
  'flex items-center gap-1.5 border-foreground bg-foreground text-background hover:bg-foreground/90'

/** Your own words, muted, with a pencil: a line with no quick replies, or words an older build held. */
const CHIP_OWN_WORDS = 'flex items-center gap-1.5 text-muted-foreground'

/** A chip's tooltip: Recommended on the recommended reply, over the reply's own detail. */
export function botItemChipTitle(
  reply: BotItemQuickReply,
  recommended: string
): string | undefined {
  return (
    [reply.recommended ? recommended : null, reply.detail].filter(Boolean).join('\n') || undefined
  )
}

/** A reply's words. The recommended one leads with a star and carries Recommended in its name, filled
 *  or not: reopening an answered line keeps the mark on it. */
export function BotItemChipWords({ reply }: { reply: BotItemQuickReply }): React.JSX.Element {
  const t = useTranslate()
  if (!reply.recommended) {
    return <>{reply.label}</>
  }
  // A text star, not an icon: no line break falls between it and the label's first word.
  return (
    <span>
      <span aria-hidden className="mr-[5px] text-[11px] opacity-80">
        ★
      </span>
      {reply.label}
      <span className="sr-only">, {t('bots.items.ask.recommended', 'Recommended')}</span>
    </span>
  )
}

/** "Question → answer", muted: an answered line, or answers held for an ask the agent no longer waits
 *  on ("not sent yet"), which go into the comment box on click. */
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

/** "✓ Question… → answer" on one row: the question gives way (an ellipsis), the answer stays whole. A
 *  pick reopens on click; an answer given or on its way doesn't. */
function FoldedLine({
  question,
  words,
  onOpen
}: {
  question: string
  words: string
  onOpen?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const line = botItemQuestionLine(question)
  const content = (
    <>
      <Check aria-hidden className="size-3 shrink-0 self-center text-status-success" />
      {/* The question takes only its text's width, the arrow right after it. When the row is short it
          gives way first, keeping at least 40%: an answer past 60% (less the check and arrow) gives
          way too. Both stay whole in the title. */}
      <span className="min-w-0 truncate">{line}</span>
      <span aria-hidden className="shrink-0">
        →
      </span>
      <span className="max-w-[calc(60%-2.5rem)] shrink-0 truncate text-foreground/72">{words}</span>
    </>
  )
  const row =
    'flex w-full min-w-0 items-baseline gap-1.5 text-left text-[13px] leading-[19px] text-muted-foreground'
  return onOpen ? (
    <button
      type="button"
      title={`${line} → ${words}`}
      aria-label={t('bots.items.ask.changeAnswer', '{{question}}: {{answer}}. Change answer', {
        question: line,
        answer: words
      })}
      className={cn(
        row,
        // A hover fill a little past the text says it opens.
        '-mx-1.5 w-[calc(100%+0.75rem)] cursor-pointer rounded-md px-1.5 outline-none hover:bg-foreground/4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <p title={`${line} → ${words}`} className={row}>
      {content}
    </p>
  )
}

/** Where focus goes once the card shows the change: never a ring after a mouse pick (the ring is
 *  `focus-visible`), and the page scrolls only when the target is out of view. */
type FocusTarget =
  | { kind: 'next'; after: number }
  | { kind: 'chip'; index: number; label: string }
  | { kind: 'send' }

function focusInView(node: HTMLElement | null | undefined): void {
  if (node) {
    node.focus({ preventScroll: true })
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

export function BotItemQuestionStep({
  shape,
  answered,
  steps,
  actions
}: {
  shape: BotItemQuestionShape
  /** Per line, the words a posted comment, or a send on its way, answered it with. */
  answered: readonly (string | null)[]
  steps: BotItemQuestionSteps
  actions: BotItemQuickReplyActions
}): React.JSX.Element {
  const t = useTranslate()
  const recommended = t('bots.items.ask.recommended', 'Recommended')
  // A picked line reopened to change its pick; a new pick folds it again.
  const [reopened, setReopened] = useState<number | null>(null)
  const targets = useRef(new Map<string, HTMLButtonElement>())
  const sendButton = useRef<HTMLButtonElement | null>(null)
  const focusNext = useRef<FocusTarget | null>(null)
  const { picks, lines } = steps
  const target = (key: string) => (node: HTMLButtonElement | null) => {
    if (node) {
      targets.current.set(key, node)
    } else {
      targets.current.delete(key)
    }
  }
  // A line's first control: its first quick reply, else its Type your answer.
  const firstOf = (index: number): HTMLButtonElement | undefined =>
    targets.current.get(`${index}:0`) ?? targets.current.get(`${index}:type`)
  useLayoutEffect(() => {
    const next = focusNext.current
    focusNext.current = null
    if (!next) {
      return
    }
    if (next.kind === 'chip') {
      focusInView(targets.current.get(`${next.index}:${next.label}`))
      return
    }
    if (next.kind === 'next') {
      const ahead = [
        ...lines.filter((at) => at > next.after),
        ...lines.filter((at) => at < next.after)
      ]
      const open = ahead.find((at) => !picks[at])
      if (open !== undefined) {
        focusInView(firstOf(open))
        return
      }
    }
    focusInView(sendButton.current)
  })
  const typed = (index: number): boolean => {
    const words = picks[index]
    return words !== null && !shape.decisions[index]!.replies.some((reply) => reply.label === words)
  }
  const choose = (index: number, label: string): void => {
    const clearing = picks[index] === label
    steps.pick(index, label)
    if (clearing) {
      // Cleared: the line stays open, and focus on the chip.
      setReopened(index)
      focusNext.current = { kind: 'chip', index, label }
    } else {
      setReopened(null)
      focusNext.current = { kind: 'next', after: index }
    }
  }
  const ownWords = (index: number, words: string | null): void => {
    // Your words for this line, in the box: they take over its pick, and Enter answers it.
    steps.bind(index)
    if (words === null) {
      actions.type()
    } else {
      actions.edit(words)
    }
  }
  const send = (): void => {
    const outcome = steps.send()
    if (outcome !== 'empty') {
      // Sent, or nothing left to send: focus stays on Send.
      return
    }
    const first = lines[0]!
    const control = firstOf(first)
    if (shape.decisions[first]!.replies.length > 0 && control) {
      focusInView(control)
    } else {
      ownWords(first, null)
    }
  }
  // Of the lines still open: what Send posts, out of what it could.
  const count = picks.filter(Boolean).length
  const partial = count > 0 && count < lines.length
  // Every line sent and on its way: Send stays, so focus does, and reads as sending until the read.
  const { sending } = steps
  return (
    <>
      {shape.decisions.map((decision, index) => {
        const words = answered[index]
        const open = lines.includes(index)
        const pick = open ? picks[index] : null
        const divider = index > 0 ? 'mt-3 border-t border-border pt-3' : undefined
        if (!open || (pick && reopened !== index)) {
          const shown = pick ?? words
          return (
            // A decision's question is unique within its ask.
            <div key={decision.question} className={divider}>
              {shown ? (
                <FoldedLine
                  question={decision.question}
                  words={shown}
                  onOpen={
                    pick
                      ? () => {
                          setReopened(index)
                          focusNext.current = { kind: 'chip', index, label: pick }
                        }
                      : undefined
                  }
                />
              ) : (
                // Answered by a comment that named no line: the comment shows as itself.
                <div className="font-medium text-muted-foreground [&_*]:text-muted-foreground [&_p]:font-medium">
                  <BotItemMarkdown text={decision.question} />
                </div>
              )}
            </div>
          )
        }
        return (
          <div key={decision.question} className={divider}>
            <div className={cn('min-w-0', BOT_ITEM_OPEN_QUESTION)}>
              <BotItemMarkdown text={decision.question} />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {decision.replies.map((reply, at) => {
                const picked = pick === reply.label
                return (
                  <button
                    key={reply.label}
                    ref={(node) => {
                      target(`${index}:${reply.label}`)(node)
                      if (at === 0) {
                        target(`${index}:0`)(node)
                      }
                    }}
                    type="button"
                    title={botItemChipTitle(reply, recommended)}
                    aria-pressed={picked}
                    className={cn(
                      BOT_ITEM_CHIP,
                      CHIP_ACTION,
                      // Recommended reads by its star alone: only a pick is filled.
                      picked ? CHIP_PICKED : 'text-foreground'
                    )}
                    onClick={(event) => {
                      if (event.altKey || event.shiftKey) {
                        ownWords(index, reply.label)
                      } else {
                        choose(index, reply.label)
                      }
                    }}
                  >
                    {picked ? <Check className="size-3 shrink-0" /> : null}
                    <span className="min-w-0 max-w-full">
                      {/* The star marks the recommended reply until the line has a pick. */}
                      {pick === null ? <BotItemChipWords reply={reply} /> : reply.label}
                    </span>
                  </button>
                )
              })}
              {pick !== null && typed(index) ? (
                // Words held by an older build for this line: back into the box, whose Enter sends them.
                <button
                  // Reopening a typed pick focuses it, as a picked reply would be.
                  ref={target(`${index}:${pick}`)}
                  type="button"
                  className={cn(BOT_ITEM_CHIP, CHIP_ACTION, CHIP_PICKED)}
                  onClick={() => ownWords(index, pick)}
                >
                  <Pencil className="size-3 shrink-0" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{pick}</span>
                </button>
              ) : null}
              {decision.replies.length === 0 && pick === null ? (
                <button
                  ref={target(`${index}:type`)}
                  type="button"
                  className={cn(BOT_ITEM_CHIP, CHIP_ACTION, CHIP_OWN_WORDS)}
                  onClick={() => ownWords(index, null)}
                >
                  <Pencil className="size-3 shrink-0" />
                  {t('bots.items.ask.typeAnswer', 'Type your answer')}
                </button>
              ) : null}
            </div>
          </div>
        )
      })}
      <div className="mt-4 flex justify-end">
        <Button
          ref={sendButton}
          type="button"
          size="sm"
          aria-label={
            partial
              ? t('bots.items.ask.sendSomeLabel', 'Send {{count}} of {{total}} answers', {
                  count,
                  total: lines.length
                })
              : undefined
          }
          aria-busy={sending || undefined}
          onClick={send}
        >
          {sending ? (
            <>
              <LoaderCircle aria-hidden className="size-3 animate-spin" />
              {t('bots.items.ask.sending', 'Sending…')}
            </>
          ) : partial ? (
            t('bots.items.ask.sendSome', 'Send {{count}}/{{total}}', {
              count,
              total: lines.length
            })
          ) : (
            t('bots.items.ask.send', 'Send')
          )}
        </Button>
      </div>
    </>
  )
}
