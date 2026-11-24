// The owner's answers to an ask of several questions, as one comment: one line per question, each
// written as a quick reply of several questions writes it ("Question → answer"). Older clients post
// each line as its own comment; both read the same way.
// Hosts keep the waiting ask that pairing works out from what this file reads, writes or limits: any change
// to it bumps WAITING_ASK_RULES (src/main/bots/bot-item-waiting-ask-keep.ts).
import {
  botItemPickedReplies,
  botItemLineHeads,
  botItemQuestionLine,
  botItemQuickReplyText,
  type BotItemQuestionShape
} from './bot-item-ask'
import { botItemCommentImages } from './bot-items'
import { stripSentImagePromptMarkers } from '../native-chat/transcript/images/native-chat-sent-image-prompt-markers'

type NamedAnswerLine = { lineIndex: number; head: string; words: string }

/** The comment line assigned to each question. A bare head reserves a question with no answer. */
export function botItemNamedAnswerLines(
  shape: BotItemQuestionShape,
  text: string
): (NamedAnswerLine | null)[] {
  const named: (NamedAnswerLine | null)[] = shape.decisions.map(() => null)
  text.split('\n').forEach((rawLine, lineIndex) => {
    const line = rawLine.trim()
    const heads = botItemLineHeads(shape, line)
    let best = -1
    heads.forEach((head, index) => {
      if (head === undefined) {
        return
      }
      const longer = best === -1 || head.length > (heads[best]?.length ?? 0)
      const free =
        head.length === heads[best]?.length && named[best] !== null && named[index] === null
      if (longer || free) {
        best = index
      }
    })
    const head = heads[best]
    if (head !== undefined && named[best] === null) {
      named[best] = { lineIndex, head, words: line.slice(head.length).trim() }
    }
  })
  return named
}

export function botItemNamedAnswers(shape: BotItemQuestionShape, text: string): (string | null)[] {
  return botItemNamedAnswerLines(shape, text).map((line) => line?.words || null)
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
 *  reply writes exactly what its chip posts on its own. An unanswered line whose first line a later
 *  answered one shares keeps a bare "Question →", so that answer reads back on its own line, not on
 *  the first line with its lead. */
export function botItemAnswersText(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[]
): string {
  const leads = shape.decisions.map((decision) => botItemQuestionLine(decision.question))
  return answerLines(shape, answers, (index) =>
    leads.some((lead, at) => at > index && lead === leads[index] && Boolean(answers[at]?.trim()))
  )
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
  const text = typeof reply.text === 'string' ? reply.text.trim() : ''
  const recorded = Array.isArray(reply.decisions)
  const line = recorded ? null : botItemNamedAnswerLines(shape, text)[index]
  const ownReply = line ? { ...reply, text: `${line.head} ${line.words}`.trim() } : reply
  const picks = botItemPickedReplies(shape, ownReply)[index] ?? []
  if (picks.length > 0) {
    return picks.map((pick) => pick.label).join(', ')
  }
  if (recorded) {
    return null
  }
  const words = line?.words || text
  // Its images show on its own card, so the [Image #N] its send wrote go; an image alone keeps its mark.
  return words
    ? stripSentImagePromptMarkers(words, botItemCommentImages(reply).length).trim() || words
    : null
}

/** Answers held for an earlier ask, less the lines a comment answered meanwhile: what recovering them
 *  puts back in the box. */
export function botItemUnsentAnswers(
  held: readonly (string | null)[],
  answered: readonly (string | null)[]
): (string | null)[] {
  return held.map((words, index) => (answered[index] ? null : words))
}

/** A ride-along comment: the picks' lines, then the owner's own words, which answer no line. A line of
 *  those words that would read as answering one of the ask's questions ("Question → …") is quoted
 *  ("> "), again until no question's lead matches it, so it can't settle that question unseen; every
 *  other line stays as typed. A lead is finite, so the quoting stops. */
export function botItemRideAlongText(
  shape: BotItemQuestionShape,
  picks: readonly (string | null)[],
  text: string
): string {
  const words = text.split('\n').map((line) => {
    let quoted = line
    while (botItemLineHeads(shape, quoted.trim()).some(Boolean)) {
      quoted = `> ${quoted}`
    }
    return quoted
  })
  const answered = botItemAnswersText(shape, picks)
  return answered ? `${answered}\n${words.join('\n')}` : words.join('\n')
}
