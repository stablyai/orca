// The owner's answers to an ask of several questions, as one comment: one line per question, each
// written as a quick reply of several questions writes it ("Question → answer"). Older clients post
// each line as its own comment; both read the same way.
// Hosts keep the waiting ask that pairing works out from what this file reads, writes or limits: any change
// to it bumps WAITING_ASK_RULES (src/main/bots/bot-item-waiting-ask-keep.ts).
import {
  botItemPickedReplies,
  botItemQuestionLeads,
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
  // Each question's leads as this build and older ones wrote them; a line takes the first that it starts with.
  const leads = shape.decisions.map((decision) =>
    botItemQuestionLeads(decision.question).map((lead) => `${lead} →`)
  )
  const answers: (string | null)[] = shape.decisions.map(() => null)
  const taken = shape.decisions.map(() => false)
  for (const line of text.split('\n').map((l) => l.trim())) {
    const heads = leads.map((options) => options.find((head) => line.startsWith(head)))
    let best = -1
    heads.forEach((head, index) => {
      if (head === undefined) {
        return
      }
      const longer = best === -1 || head.length > (heads[best]?.length ?? 0)
      const free = head.length === heads[best]?.length && taken[best] && !taken[index]
      if (longer || free) {
        best = index
      }
    })
    const head = heads[best]
    const words = head === undefined ? '' : line.slice(head.length).trim()
    if (head !== undefined && !taken[best] && (words || line === head)) {
      taken[best] = true
      answers[best] = words || null
    }
  }
  return answers
}

function answerLines(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[],
  keepsPlace: (index: number) => boolean
): string {
  return shape.decisions
    .flatMap((decision, index) => {
      const words = answers[index]?.replace(/\s+/g, ' ').trim()
      if (!words) {
        return keepsPlace(index) ? [`${botItemQuestionLine(decision.question)} →`] : []
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

/** One comment for a set of answers: a line per answered question, in the ask's order; a picked quick
 *  reply writes exactly what its chip posts on its own. */
export function botItemAnswersText(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[]
): string {
  return answerLines(shape, answers, () => false)
}

/** Answers held on this device as their draft stores them: an open line whose first line another
 *  question shares keeps a bare "Question →", so the answers after it read back on their own lines. */
export function botItemHeldAnswersText(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[]
): string {
  if (!answers.some((words) => words?.trim())) {
    return ''
  }
  const leads = shape.decisions.map((decision) => botItemQuestionLine(decision.question))
  return answerLines(shape, answers, (index) =>
    leads.some((lead, at) => at !== index && lead === leads[index])
  )
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
