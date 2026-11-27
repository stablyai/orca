// The waiting ask of several questions, as steps: each answered or picked line folds to one muted row
// ("✓ Label: answer", Change on a pick), and only the first open line shows, bold over its reply rows.
// Nothing posts until Send, which posts the picks as one comment; lines left open go as no answer. A
// line answered, or sent and on its way, folds the same and stays. The comment box below still types:
// its Enter holds the words, with their images, files and skills, as the answer of the line its
// "Replying to" names, like a pick.
import { LoaderCircle } from 'lucide-react'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botItemQuestionLine,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import {
  botItemHeldAnswerIsReply,
  type BotItemHeldAnswer
} from '../../../../../shared/bots/bot-item-held-answers'
import { BotItemMarkdown } from './BotItemMarkdown'
import { BotItemFoldedLine, botItemShownAnswer } from './BotItemFoldedAnswer'
import { BotItemQuickReplyRows } from './BotItemQuickReplyRows'
import type { BotItemQuestionSteps, BotItemQuickReplyActions } from './use-bot-item-question-steps'

/** An answer's Markdown on its line: its first paragraph runs on after the arrow. */
const ANSWER_MARKDOWN = 'contents text-foreground/72 [&>p:first-child]:inline'

/** "Question → answer", muted: an answered line, its own words drawn as a comment is (`markdown`), or
 *  answers held for an ask the agent no longer waits on ("not sent yet"), which go into the comment
 *  box on click. */
export function BotItemAnswerLine({
  question,
  words,
  markdown,
  onClick
}: {
  question: string
  words: string
  markdown?: boolean
  onClick?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const line = 'block w-full text-left text-[13px] leading-[19px] text-muted-foreground'
  const lead = `${botItemQuestionLine(question)} → `
  const answerClass = 'text-foreground/72 [overflow-wrap:anywhere]'
  return onClick ? (
    <button
      type="button"
      className={cn(
        line,
        'rounded-sm outline-none hover:[&>span]:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
      onClick={onClick}
    >
      {lead}
      <span className={answerClass}>{words}</span>
      {' · '}
      {t('bots.items.ask.notSentYet', 'not sent yet')}
    </button>
  ) : (
    <div className={line}>
      {lead}
      {markdown ? (
        <BotItemMarkdown text={words} className={ANSWER_MARKDOWN} />
      ) : (
        <span className={cn(answerClass, 'whitespace-pre-line')}>{words}</span>
      )}
    </div>
  )
}

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
  const rows = useRef<HTMLDivElement | null>(null)
  const sendButton = useRef<HTMLButtonElement | null>(null)
  // After a pick, focus moves on: to the next open line's first control, else to Send.
  const moveFocus = useRef(false)
  // Per line, words typed in Other… and not held yet: kept while another line shows.
  const [drafts, setDrafts] = useState<Readonly<Record<number, string>>>({})
  // What waits for a hold of Other… words to show in the picks: Send, or an answer into the box.
  const afterHold = useRef<
    { kind: 'send' } | { kind: 'restore'; index: number; pick: BotItemHeldAnswer } | null
  >(null)
  // A picked line reopened by Change (the steps keep it); its pick, or a new one, folds it again.
  const { picks, lines, sending, reopened } = steps
  const shown =
    reopened !== null && lines.includes(reopened) ? reopened : lines.find((index) => !picks[index])
  const draft = shown === undefined ? '' : (drafts[shown] ?? '').trim()
  useLayoutEffect(() => {
    if (!moveFocus.current) {
      return
    }
    moveFocus.current = false
    // A reopened line's own pick first, so Enter keeps it; else its first control.
    focusInView(
      rows.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
        rows.current?.querySelector<HTMLElement>('button, input') ??
        sendButton.current
    )
  })
  const setDraft = (index: number, words: string): void =>
    setDrafts((previous) => ({ ...previous, [index]: words }))
  // The line's pick again keeps it and folds the line, as a new pick does.
  const hold = (index: number, words: string): void => {
    steps.pick(index, words)
    setDraft(index, '')
    moveFocus.current = true
  }
  /** The shown line's Other… words, held as its answer before another line shows or Send posts, so
   *  only the shown line ever has words not held. True when they were. */
  const holdDraft = (): boolean => {
    if (shown === undefined || !draft) {
      return false
    }
    setDraft(shown, '')
    if (botItemHeldAnswerIsReply(picks[shown], draft)) {
      return false
    }
    steps.pick(shown, draft)
    return true
  }
  const change = (index: number, pick: BotItemHeldAnswer): void => {
    const shownPick = botItemShownAnswer(pick)
    const reply = shape.decisions[index]!.replies.some((r) =>
      botItemHeldAnswerIsReply(pick, r.label)
    )
    // Typed words with images, files or skills go back into the box, which keeps them all.
    // So does any answer to a question without replies, whose answer field is the box.
    if (
      shape.decisions[index]!.replies.length === 0 ||
      (!reply && (pick.images.length > 0 || shownPick.files.length > 0 || pick.skills.length > 0))
    ) {
      // The shown Other… words are held first; the box takes the answer once that shows, as two
      // writes in one click would race.
      if (holdDraft()) {
        afterHold.current = { kind: 'restore', index, pick }
      } else {
        ownWords(index, pick)
      }
      return
    }
    holdDraft()
    if (!reply) {
      // Words already being revised there stay; else the held words, to change.
      setDraft(index, drafts[index]?.trim() ? drafts[index]! : pick.words)
    }
    steps.reopen(index)
    moveFocus.current = true
  }
  const send = (): void => {
    if (holdDraft()) {
      // Sent once the hold shows in the picks.
      afterHold.current = { kind: 'send' }
      return
    }
    steps.send()
  }
  const ownWords = (index: number, words: BotItemHeldAnswer | string): void => {
    // Your words for this line, in the box: they take over its pick, and Enter answers it. A held
    // answer stays held until the box's draft is saved, so a reload can't lose it.
    if (typeof words !== 'string') {
      if (actions.restore(words)) {
        steps.bind(index)
      }
      return
    }
    steps.bind(index)
    actions.edit(words)
  }
  const runAfterHold = useEffectEvent(() => {
    const next = afterHold.current
    afterHold.current = null
    if (next?.kind === 'send') {
      steps.send()
    } else if (next) {
      ownWords(next.index, next.pick)
    }
  })
  useEffect(() => {
    if (afterHold.current) {
      runAfterHold()
    }
  }, [steps])
  const total = shape.decisions.length
  const count = shape.decisions.filter((_, index) => picks[index] || answered[index]).length
  const picked = picks.filter(Boolean).length
  return (
    <>
      {shape.decisions.map((decision, index) => {
        const open = lines.includes(index)
        const pick = open ? picks[index] : null
        const words = pick ?? answered[index]
        if (index === shown || (open && !pick)) {
          return null
        }
        return (
          // A decision's question is unique within its ask.
          <div key={decision.question}>
            {words ? (
              <BotItemFoldedLine
                question={decision.question}
                answer={words}
                onOpen={pick ? () => change(index, pick) : undefined}
              />
            ) : (
              // Answered by a comment that named no line: the comment shows as itself.
              <p className="py-1 text-[13px] leading-[19px] text-muted-foreground">
                {botItemQuestionLine(decision.question)}
              </p>
            )}
          </div>
        )
      })}
      {shown !== undefined ? (
        <div className="mt-1.5">
          <div className="font-semibold [&_p]:font-semibold">
            <BotItemMarkdown text={shape.decisions[shown]!.question} />
          </div>
          <BotItemQuickReplyRows
            key={shown}
            rowsRef={rows}
            question={shape.decisions[shown]!.question}
            quickReplies={shape.decisions[shown]!.replies}
            onPick={(reply, edit) =>
              edit ? ownWords(shown, reply.label) : hold(shown, reply.label)
            }
            onOther={(words) => hold(shown, words)}
            onAnswerInBox={(words) => {
              steps.bind(shown)
              setDraft(shown, '')
              actions.type(words)
            }}
            current={picks[shown]?.words}
            other={drafts[shown] ?? ''}
            onOtherChange={(words) => setDraft(shown, words)}
          />
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {t('bots.items.ask.answeredCount', '{{count}} of {{total}} answered', { count, total })}
        </span>
        <Button
          ref={sendButton}
          type="button"
          size="sm"
          className="shrink-0"
          disabled={!sending && picked === 0 && !draft}
          aria-busy={sending || undefined}
          onClick={send}
        >
          {sending ? (
            <>
              <LoaderCircle aria-hidden className="size-3 animate-spin" />
              {t('bots.items.ask.sending', 'Sending…')}
            </>
          ) : (
            t('bots.items.ask.send', 'Send')
          )}
        </Button>
      </div>
    </>
  )
}
