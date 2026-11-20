// The owner's answers to an ask of several questions, as one comment: one line per question, each
// written as a quick reply of several questions writes it ("Question → answer"). Older clients post
// each line as its own comment; both read the same way.
import {
  botItemPickedReplies,
  botItemQuestionLine,
  botItemQuickReplyText,
  type BotItemDecision,
  type BotItemQuestionShape
} from './bot-item-ask'

/** The words after a line's "Question →", or null where `line` names another question. */
function answerOn(decision: BotItemDecision, line: string): string | null {
  const head = `${botItemQuestionLine(decision.question)} →`
  return line.startsWith(head) ? line.slice(head.length).trim() : null
}

/** Per question line, the answer a comment names for it ("Question → answer"), else null. */
export function botItemNamedAnswers(shape: BotItemQuestionShape, text: string): (string | null)[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return shape.decisions.map((decision) => {
    for (const line of lines) {
      const words = answerOn(decision, line)
      if (words) {
        return words
      }
    }
    return null
  })
}

/** One comment for a set of answers: a line per answered question, in the ask's order; a picked quick
 *  reply writes exactly what its chip posts on its own. */
export function botItemAnswersText(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[]
): string {
  return shape.decisions
    .flatMap((decision, index) => {
      const words = answers[index]?.replace(/\s+/g, ' ').trim()
      if (!words) {
        return []
      }
      const reply = decision.replies.find((option) => option.label === words)
      return [
        reply
          ? botItemQuickReplyText(shape, decision, reply)
          : `${botItemQuestionLine(decision.question)} → ${words}`
      ]
    })
    .join('\n')
}

/** What an owner's comment answered on one question line, for its "Question → answer" look: the quick
 *  replies it picked, its words for that line, or all its words; null for a recorded answer's words. */
export function botItemAnswerWords(
  shape: BotItemQuestionShape,
  index: number,
  reply: Record<string, unknown>
): string | null {
  const picks = botItemPickedReplies(shape, reply)[index] ?? []
  if (picks.length > 0) {
    return picks.map((pick) => pick.label).join(', ')
  }
  if (Array.isArray(reply.decisions)) {
    return null
  }
  const text = typeof reply.text === 'string' ? reply.text.trim() : ''
  return botItemNamedAnswers(shape, text)[index] ?? (text || null)
}
