// The owner's answers to an ask of several questions, as one comment: one line per question, each
// written as a quick reply of several questions writes it ("Question → answer"). Older clients post
// each line as its own comment; both read the same way.
import {
  botItemAnswerHead,
  botItemQuestionLine,
  botItemQuickReplyText,
  type BotItemQuestionShape
} from './bot-item-ask'
import {
  offsetSentImagePromptMarkers,
  sentImagePromptMarkerNumbers
} from '../native-chat/transcript/images/native-chat-sent-image-prompt-markers'

/** Per question line, the comment line that answers it (its index in the text's lines) and its words. */
type NamedAnswer = { words: string; at: number }

function namedAnswers(shape: BotItemQuestionShape, text: string): (NamedAnswer | null)[] {
  const named: (NamedAnswer | null)[] = shape.decisions.map(() => null)
  const exact = shape.decisions.map((_, index) => `${botItemAnswerHead(shape, index)} →`)
  // Written before questions sharing a first line were numbered: those go in the ask's order.
  const plain = shape.decisions.map((decision) => `${botItemQuestionLine(decision.question)} →`)
  // A line goes to the question with the longest lead, as one question's words may lead another's.
  const longest = (line: string, heads: readonly string[]): number =>
    heads.reduce(
      (best, head, index) =>
        line.startsWith(head) && (best === -1 || head.length > heads[best]!.length) ? index : best,
      -1
    )
  for (const [at, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    let index = longest(line, exact)
    let head = exact[index]
    if (index === -1) {
      const lead = longest(line, plain)
      head = plain[lead]
      index = lead === -1 ? -1 : plain.findIndex((other, at_) => other === head && !named[at_])
    }
    const words = head && index !== -1 ? line.slice(head.length).trim() : ''
    // Each comment line answers one question: a second line for it ("Q → revised") stays the comment's.
    if (words && !named[index]) {
      named[index] = { words, at }
    }
  }
  return named
}

/** Per question line, the answer a comment names for it ("Question → answer"), else null. */
export function botItemNamedAnswers(shape: BotItemQuestionShape, text: string): (string | null)[] {
  return namedAnswers(shape, text).map((named) => named?.words ?? null)
}

/** A comment's own words besides the "Question → answer" lines that answer `lines`. */
export function botItemAnswersRest(
  shape: BotItemQuestionShape,
  text: string,
  lines: readonly number[]
): string {
  const named = namedAnswers(shape, text)
  const used = new Set(lines.flatMap((index) => (named[index] ? [named[index].at] : [])))
  return text
    .split('\n')
    .filter((_, at) => !used.has(at))
    .join('\n')
    .trim()
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
          : `${botItemAnswerHead(shape, index)} → ${words}`
      ]
    })
    .join('\n')
}

/** One question line's answer as held on this device: its words, whose [Image #N] name its own images. */
export type BotItemHeldAnswer = { words: string; paths: readonly string[] }

/** The images a line's [Image #N] name, each once, by their place in the comment's images (0-based);
 *  a marker in code is words. */
export function botItemLineImages(words: string, imageCount: number): number[] {
  const places = sentImagePromptMarkerNumbers(words).map((number) => number - 1)
  return [...new Set(places)].filter((at) => at >= 0 && at < imageCount)
}

/** One comment for a set of answers, with each line's images in line order: a line's [Image #N] are
 *  numbered after the images of the lines above it. */
export function botItemAnswersComment(
  shape: BotItemQuestionShape,
  answers: readonly (BotItemHeldAnswer | null)[]
): { text: string; paths: string[] } {
  const paths: string[] = []
  const words = shape.decisions.map((_, index) => {
    const answer = answers[index]
    if (!answer) {
      return null
    }
    const numbered = offsetSentImagePromptMarkers(answer.words, answer.paths.length, paths.length)
    paths.push(...answer.paths)
    return numbered
  })
  return { text: botItemAnswersText(shape, words), paths }
}

/** The answers split, whole lines in the ask's order, so no comment carries more than `maxImages`. */
export function botItemAnswerBatches(
  shape: BotItemQuestionShape,
  answers: readonly (BotItemHeldAnswer | null)[],
  maxImages: number
): (BotItemHeldAnswer | null)[][] {
  const empty = (): (BotItemHeldAnswer | null)[] => shape.decisions.map(() => null)
  const batches = [empty()]
  let images = 0
  shape.decisions.forEach((_, index) => {
    const answer = answers[index]
    if (!answer) {
      return
    }
    if (batches.at(-1)!.some(Boolean) && images + answer.paths.length > maxImages) {
      batches.push(empty())
      images = 0
    }
    batches.at(-1)![index] = answer
    images += answer.paths.length
  })
  return batches.filter((batch) => batch.some(Boolean))
}
