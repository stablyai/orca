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
  type BotItemDecision,
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

function normalizeAnswerLine(words: string): string {
  return words.replace(/\s+/g, ' ').trim()
}

function answerLines(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[],
  keepsPlace: (index: number) => boolean
): string {
  return shape.decisions
    .flatMap((decision, index) => {
      const head = `${botItemQuestionLine(decision.question)} →`
      const words = normalizeAnswerLine(answers[index] ?? '')
      if (!words) {
        return keepsPlace(index) ? [head] : []
      }
      const reply =
        shape.decisions.length === 1
          ? decision.replies.find((option) => option.label === words)
          : undefined
      if (reply) {
        return [botItemQuickReplyText(shape, decision, reply)]
      }
      // Extra separator space defeats a longer heading without changing the parsed answer.
      let separator = ' '
      while (
        botItemLineHeads(shape, `${head}${separator}${words}`).some(
          (candidate) => (candidate?.length ?? 0) > head.length
        )
      ) {
        separator += ' '
      }
      return [`${head}${separator}${words}`]
    })
    .join('\n')
}

/** One comment for a set of answers, in the ask's order. A bare "Question →" reserves an unanswered
 *  question's position when its heading matches a later answered question's. */
export function botItemAnswersText(
  shape: BotItemQuestionShape,
  answers: readonly (string | null)[]
): string {
  const leads = shape.decisions.map((decision) => botItemQuestionLine(decision.question))
  return answerLines(shape, answers, (index) =>
    leads.some((lead, at) => at > index && lead === leads[index] && Boolean(answers[at]?.trim()))
  )
}

/** What an owner's comment answered on one question line, for its "Question → answer" look: the quick
 *  replies it picked (`picked`), its words for that line, or all its words; null for a recorded
 *  answer's words. */
export function botItemAnswer(
  shape: BotItemQuestionShape,
  index: number,
  reply: Record<string, unknown>
): { words: string; picked: boolean } | null {
  const text = typeof reply.text === 'string' ? reply.text.trim() : ''
  const recorded = Array.isArray(reply.decisions)
  const line = recorded ? null : botItemNamedAnswerLines(shape, text)[index]
  const ownReply = line ? { ...reply, text: `${line.head} ${line.words}`.trim() } : reply
  const picks = botItemPickedReplies(shape, ownReply)[index] ?? []
  if (picks.length > 0) {
    return { words: picks.map((pick) => pick.label).join(', '), picked: true }
  }
  if (recorded) {
    return null
  }
  const words = line?.words || text
  if (!words) {
    return null
  }
  if (line?.words && picksNormalizedReplies(shape.decisions[index], line.words)) {
    return { words: line.words, picked: true }
  }
  // Its images show on its own card, so the [Image #N] its send wrote go; an image alone keeps its mark.
  return {
    words: stripSentImagePromptMarkers(words, botItemCommentImages(reply).length).trim() || words,
    picked: false
  }
}

/** Whether a line's words pick the decision's quick replies once their labels collapse spaces, as a
 *  sent answer line writes them. */
function picksNormalizedReplies(decision: BotItemDecision | undefined, words: string): boolean {
  if (!decision?.replies.some(({ label }) => normalizeAnswerLine(label) !== label)) {
    return false
  }
  const replies = decision.replies.map((option) => ({
    ...option,
    label: normalizeAnswerLine(option.label)
  }))
  const [picks] = botItemPickedReplies(
    { body: '', decisions: [{ ...decision, replies }] },
    { text: words }
  )
  return (picks?.length ?? 0) > 0
}

export function botItemAnswerWords(
  shape: BotItemQuestionShape,
  index: number,
  reply: Record<string, unknown>
): string | null {
  return botItemAnswer(shape, index, reply)?.words ?? null
}

/** Answers held for an earlier ask, less the lines a comment answered meanwhile: what recovering them
 *  puts back in the box. */
export function botItemUnsentAnswers<T>(
  held: readonly (T | null)[],
  answered: readonly (string | null)[]
): (T | null)[] {
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

/** A comment's own words beside its "Question → answer" lines for the lines it `answered`, which read
 *  on the ask's lines (a ride-along comment); null when it holds no other words or answers none. */
export function botItemWordsBesideAnswers(
  shape: BotItemQuestionShape,
  text: string,
  answered: readonly boolean[]
): string | null {
  const named = botItemNamedAnswerLines(shape, text)
  // A bare "Question →" only reserves its place for a later answered line with the same heading.
  const reserves = (index: number): boolean =>
    named[index]?.words === '' &&
    named.some(
      (other, later) => later > index && answered[later] && other?.head === named[index]?.head
    )
  const taken = new Set(
    named.flatMap((line, index) =>
      line && (answered[index] || reserves(index)) ? [line.lineIndex] : []
    )
  )
  if (taken.size === 0) {
    return null
  }
  const rest = text
    .split('\n')
    .filter((_, at) => !taken.has(at))
    .join('\n')
    .trim()
  return rest || null
}
