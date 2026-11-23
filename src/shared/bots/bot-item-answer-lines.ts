// The owner's answers to an ask of several questions, as one comment: one line per question, each
// written as a quick reply of several questions writes it ("Question → answer"). Older clients post
// each line as its own comment; both read the same way.
import {
  botItemPickedReplies,
  botItemQuestionLine,
  botItemQuickReplyText,
  type BotItemQuestionShape
} from './bot-item-ask'
import { botItemCommentImages } from './bot-items'
import { stripSentImagePromptMarkers } from '../native-chat/transcript/images/native-chat-sent-image-prompt-markers'

/** Per question line, the answer a comment names for it ("Question → answer"), else null. A line
 *  belongs to the question with the longest matching lead, as one question's words may lead another's;
 *  questions whose first lines read the same take their lines in the ask's order, a bare "Question →"
 *  keeping an open one's place. */
export function botItemNamedAnswers(shape: BotItemQuestionShape, text: string): (string | null)[] {
  const heads = shape.decisions.map((decision) => `${botItemQuestionLine(decision.question)} →`)
  const answers: (string | null)[] = shape.decisions.map(() => null)
  const taken = shape.decisions.map(() => false)
  for (const line of text.split('\n').map((l) => l.trim())) {
    let best = -1
    heads.forEach((head, index) => {
      if (!line.startsWith(head)) {
        return
      }
      const longer = best === -1 || head.length > heads[best].length
      const free = head.length === heads[best]?.length && taken[best] && !taken[index]
      if (longer || free) {
        best = index
      }
    })
    const words = best === -1 ? '' : line.slice(heads[best].length).trim()
    if (best !== -1 && !taken[best] && (words || line === heads[best])) {
      taken[best] = true
      answers[best] = words || null
    }
  }
  return answers
}

/** One comment for a set of answers: a line per answered question, in the ask's order; a picked quick
 *  reply writes exactly what its chip posts on its own. An open line whose first line a later answered
 *  question shares keeps a bare "Question →", so that answer reads back on its own line. */
export function botItemAnswersText(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[]
): string {
  if (!answers.some((words) => words?.trim())) {
    return ''
  }
  const leads = shape.decisions.map((decision) => botItemQuestionLine(decision.question))
  return shape.decisions
    .flatMap((decision, index) => {
      const words = answers[index]?.replace(/\s+/g, ' ').trim()
      if (!words) {
        return leads.some((lead, at) => at > index && lead === leads[index] && answers[at]?.trim())
          ? [`${leads[index]} →`]
          : []
      }
      const reply = decision.replies.find((option) => option.label === words)
      return [reply ? botItemQuickReplyText(shape, decision, reply) : `${leads[index]} → ${words}`]
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
  const words = botItemNamedAnswers(shape, text)[index] ?? (text || null)
  // Its images show on its own card, so the [Image #N] its send wrote go; an image alone keeps its mark.
  return (
    words &&
    (stripSentImagePromptMarkers(words, botItemCommentImages(reply).length).trim() || words)
  )
}

/** Answers held for an earlier ask, less the lines a comment answered meanwhile: what recovering them
 *  puts back in the box. */
export function botItemUnsentAnswers(
  held: readonly (string | null)[],
  answered: readonly (string | null)[]
): (string | null)[] {
  return held.map((words, index) => (answered[index] ? null : words))
}
