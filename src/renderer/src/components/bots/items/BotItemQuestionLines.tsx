// A Needs you comment's question footer: under the body, each question line (`--ask`) with its quick
// replies. While the item waits on it, the open line reads bold over its reply rows (BotItemQuickReplyRows).
// One question: a quick reply posts its words as the owner's comment, and Alt- or Shift-click puts them
// in the comment box to add to first; Other… sends typed words. Several: every line at once
// (BotItemQuestionStep), picks held until Send. Answered, a line reads "Question → answer", muted,
// and the answer's own card is not drawn again.
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botItemQuickReplyText,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import {
  botItemAnswer,
  botItemUnsentAnswers
} from '../../../../../shared/bots/bot-item-answer-lines'
import { botItemHeldAnswersComment } from '../../../../../shared/bots/bot-item-held-answers'
import {
  botItemShownAskEnd,
  type BotItemAskEnd
} from '../../../../../shared/bots/bot-item-question-answers'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemMarkdown } from './BotItemMarkdown'
import { BotItemAnswerLine, BotItemQuestionStep } from './BotItemQuestionStep'
import { BotItemQuickReplyRows } from './BotItemQuickReplyRows'
import { BotItemHeldAnswerAttachments, botItemShownAnswer } from './BotItemFoldedAnswer'
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
  onShowLive,
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
  /** Replaced: shows the ask that waits now. */
  onShowLive?: () => void
  /** While it waits, what its quick replies do; absent where the item takes no comment. */
  actions?: BotItemQuickReplyActions
  /** Its spacing from the body above; by default a gap under a body. */
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const steps = actions?.steps?.askId === askId ? actions.steps : null
  const several = shape.decisions.length > 1
  // Answers held for an ask the agent no longer waits on (it asked again): its draft, until sent.
  const stored = useBotItemHeldAnswers(heldScope ?? NO_HELD_SCOPE, shape)
  // Its sends on their way: shown on their lines until the host's read has them.
  const sent = actions?.sent?.get(askId) ?? null
  const lines = shape.decisions.map((_, index) => {
    // A line being stepped shows its held answer; with several questions, a comment that named no
    // line shows as itself, not as the line's answer.
    const answer =
      steps?.lines.includes(index) || (several && byOrder?.[index]) ? null : answers[index]
    if (answer) {
      const read = botItemAnswer(shape, index, answer.data)
      return read && { words: read.words, markdown: !read.picked }
    }
    const words = sent?.[index]
    return words ? { words, markdown: false } : null
  })
  const answered = lines.map((line) => line?.words ?? null)
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
  const shownEnd = botItemShownAskEnd(ended, answered)
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
                markdown={lines[index]?.markdown}
              />
            )
          }
          if (held && actions && unsent) {
            const shown = botItemShownAnswer(held)
            return (
              <div key={decision.question}>
                <BotItemAnswerLine
                  question={decision.question}
                  words={shown.words}
                  // Not sent: into the box, its files and skills too, to send as a comment.
                  onClick={() => {
                    const { text, paths, skills } = botItemHeldAnswersComment(shape, unsent)
                    // Held until the box's draft is saved, so a reload can't lose them.
                    if (actions.restore({ words: text, images: paths, skills }, true)) {
                      stored.hold(stored.held.map((entry, index) => (sent?.[index] ? entry : null)))
                    }
                  }}
                />
                <BotItemHeldAnswerAttachments images={shown.images} files={shown.files} />
              </div>
            )
          }
          return (
            // A decision's question is unique within its ask.
            <div key={decision.question}>
              <div
                className={cn(
                  open
                    ? 'font-semibold [&_p]:font-semibold'
                    : 'font-medium text-muted-foreground [&_*]:text-muted-foreground [&_p]:font-medium'
                )}
              >
                <BotItemMarkdown text={decision.question} />
              </div>
              {open && actions ? (
                <BotItemQuickReplyRows
                  question={decision.question}
                  quickReplies={decision.replies}
                  onPick={(reply, edit) => {
                    const text = botItemQuickReplyText(shape, decision, reply)
                    if (edit) {
                      actions.edit(text)
                    } else {
                      actions.send(text)
                    }
                  }}
                  onOther={actions.send}
                  onAnswerInBox={(words) => actions.type(words)}
                />
              ) : null}
            </div>
          )
        })}
      </div>
      {shownEnd === 'replaced' && onShowLive ? (
        <button
          type="button"
          className="mt-1.5 block rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onShowLive}
        >
          {t('bots.items.ask.replacedByNewer', 'Replaced by a newer question')}
        </button>
      ) : shownEnd ? (
        <div className="mt-1.5 text-xs text-muted-foreground">
          {shownEnd === 'skipped'
            ? t('bots.items.ask.skipped', 'Skipped')
            : t('bots.items.ask.replacedByNewer', 'Replaced by a newer question')}
        </div>
      ) : null}
    </div>
  )
}
