// A digit key answers the item's open ask with that quick reply, as clicking its chip would: only an ask
// of one question that picks one reply, and only while nothing answered it. Asks of several questions
// or several picks are answered in the item's own view.
import { botItemQuickReplyText, type BotItemQuickReply } from './bot-item-ask'
import type { BotItemQuestionAnswers } from './bot-item-question-answers'

/** The quick replies digits 1-9 pick on this ask, in order; none when digits can't answer it. */
export function botItemDigitReplies(
  asked: Pick<BotItemQuestionAnswers, 'shape' | 'answers' | 'waiting'> | null
): readonly BotItemQuickReply[] {
  if (!asked?.waiting || asked.shape.decisions.length !== 1) {
    return []
  }
  const [decision] = asked.shape.decisions
  if (!decision || decision.multi || asked.answers[0]) {
    return []
  }
  return decision.replies.slice(0, 9)
}

/** What digit `digit` (1-based) posts on the ask, or null when it picks nothing there. */
export function botItemDigitReplyText(
  asked: Pick<BotItemQuestionAnswers, 'shape' | 'answers' | 'waiting'> | null,
  digit: number
): string | null {
  const reply = botItemDigitReplies(asked)[digit - 1]
  if (!asked || !reply) {
    return null
  }
  return botItemQuickReplyText(asked.shape, asked.shape.decisions[0]!, reply)
}
