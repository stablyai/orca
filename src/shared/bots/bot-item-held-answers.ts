// An ask's answers held on this device until they post as one comment, desktop and phone alike: per
// question line, what the comment box sent for it (its words, the images and skills that came with
// them). The set is stored as one string, and the comment it posts as is built here at send time,
// where each line's [Image #N] are numbered after the images of the lines before it.
import * as z from 'zod'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../agent-session/agent-session-attachments'
import {
  offsetSentImagePromptMarkers,
  stripImagePromptMarker,
  stripSentImagePromptMarkers
} from '../native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { MAX_SKILL_REFS } from '../rpc-contract/structured-agent-session/structured-agent-session-message-params'
import type { BotItemQuestionShape } from './bot-item-ask'
import {
  botItemAnswersText,
  botItemNamedAnswers,
  botItemRideAlongText
} from './bot-item-answer-lines'
import { botItemCommentFiles } from './bot-item-comment-files'
import type { BotItemCommentSkill } from './bot-items'
import type { BotItemPendingIntent } from './bot-item-pending-comments'

/** One line's answer as the comment box sent it: `words` name its own `images` [Image #1]…, and a
 *  file rides in them as its `@path` pill. */
export type BotItemHeldAnswer = {
  readonly words: string
  /** The images' paths on the bot's host, in their [Image #N] order. */
  readonly images: readonly string[]
  readonly skills: readonly BotItemCommentSkill[]
}

export type BotItemHeldAnswers = readonly (BotItemHeldAnswer | null)[]

/** What the comment box sends, as a line's answer; images alone are named by their marks. */
export function botItemHeldAnswer(
  text: string,
  images: readonly string[] = [],
  skills: readonly BotItemCommentSkill[] = []
): BotItemHeldAnswer {
  const words = text.trim() || images.map((_, at) => `[Image #${at + 1}]`).join(' ')
  return { words, images, skills }
}

/** The held answer is the quick reply `label` alone: picking it again clears it. Words typed the same,
 *  or sent with images or skills, are an answer of their own, which the reply replaces. */
export function botItemHeldAnswerIsReply(
  answer: BotItemHeldAnswer | null | undefined,
  label: string
): boolean {
  return answer?.words === label && answer.images.length + answer.skills.length === 0
}

// Bumped only with a change to what a stored line holds; anything else reads as the old text.
const FORMAT = 2

const StoredLines = z.object({
  v: z.literal(FORMAT),
  lines: z.array(
    z.object({
      question: z.string(),
      words: z.string(),
      images: z.array(z.string()),
      skills: z.array(z.object({ name: z.string(), path: z.string() }))
    })
  )
})

type StoredLine = BotItemHeldAnswer & { question: string }

/** Stored lines by their question; null for text an older build stored. */
function storedLines(stored: string): StoredLine[] | null {
  if (!stored.startsWith('{')) {
    return null
  }
  try {
    const parsed = StoredLines.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data.lines : null
  } catch {
    return null
  }
}

function linesFor(shape: BotItemQuestionShape, stored: string): StoredLine[] {
  return (
    storedLines(stored) ??
    // Builds before files were held stored the words alone, as the "Question → words" lines they post as.
    botItemNamedAnswers(shape, stored).flatMap((words, index) =>
      words ? [{ question: shape.decisions[index]!.question, ...botItemHeldAnswer(words) }] : []
    )
  )
}

function writeLines(lines: readonly StoredLine[]): string {
  return lines.length > 0 ? JSON.stringify({ v: FORMAT, lines }) : ''
}

/** An ask's held answers, per question line, from what the draft store keeps. */
export function readBotItemHeldAnswers(
  shape: BotItemQuestionShape,
  stored: string
): (BotItemHeldAnswer | null)[] {
  const lines = linesFor(shape, stored)
  return shape.decisions.map(({ question }) => {
    const line = lines.find((held) => held.question === question)
    return line ? { words: line.words, images: line.images, skills: line.skills } : null
  })
}

/** What the draft store keeps for an ask's held answers: empty when none is held. */
export function writeBotItemHeldAnswers(
  shape: BotItemQuestionShape,
  held: BotItemHeldAnswers
): string {
  return writeLines(
    shape.decisions.flatMap(({ question }, index) => {
      const answer = held[index]
      return answer ? [{ question, ...answer }] : []
    })
  )
}

/** The same answer as the words a send gave its line, whatever number its images took there. */
export function botItemHeldAnswerWas(answer: BotItemHeldAnswer | null, sent: string): boolean {
  const plain = (words: string) => stripImagePromptMarker(words).replace(/\s+/g, ' ').trim()
  return answer !== null && plain(answer.words) === plain(sent)
}

/** The host has `intent`'s comment: each line it sent leaves the held answers, only where that
 *  question still holds what was sent. Lines picked since, or of questions added to the ask after the
 *  send, stay. */
export function botItemHeldAnswersAfterDelivery(
  stored: string,
  { shape, answers }: BotItemPendingIntent
): string {
  const lines = linesFor(shape, stored)
  const kept = lines.filter((line) => {
    const index = shape.decisions.findIndex(({ question }) => question === line.question)
    const sent = answers[index]
    return !(sent && botItemHeldAnswerWas(line, sent))
  })
  return kept.length === lines.length ? stored : writeLines(kept)
}

/** One comment for held answers, in the ask's order, and what rides with it: each line's images
 *  after the lines before it, renumbered to match, and each skill once. `rideAlong`: the box's words
 *  answering no line, last. */
export type BotItemHeldComment = {
  text: string
  paths: string[]
  skills: BotItemCommentSkill[]
  /** Per line, its words as the comment gives them. */
  answers: (string | null)[]
  /** The ride-along words as the box sent them, when the comment quotes them. */
  rideAlongText?: string
}

export function botItemHeldAnswersComment(
  shape: BotItemQuestionShape,
  held: BotItemHeldAnswers,
  rideAlong?: BotItemHeldAnswer
): BotItemHeldComment {
  const paths: string[] = []
  const skills = new Map<string, BotItemCommentSkill>()
  const take = ({ words, images, skills: picked }: BotItemHeldAnswer): string => {
    const numbered = offsetSentImagePromptMarkers(words, images.length, paths.length)
    paths.push(...images)
    for (const skill of picked) {
      skills.set(skill.path, skill)
    }
    return numbered
  }
  const answers = shape.decisions.map((_, index) => {
    const answer = held[index]
    return answer ? take(answer) : null
  })
  const text = rideAlong
    ? botItemRideAlongText(shape, answers, take(rideAlong))
    : botItemAnswersText(shape, answers)
  return {
    text,
    paths,
    skills: [...skills.values()],
    answers,
    ...(rideAlong ? { rideAlongText: rideAlong.words } : {})
  }
}

/** A limit of one comment that held answers would pass together, though each line alone fits. */
export type BotItemHeldAnswersLimit = { kind: 'images' | 'skills'; max: number }

export function botItemHeldAnswersOverLimit(
  answers: readonly (BotItemHeldAnswer | null | undefined)[]
): BotItemHeldAnswersLimit | null {
  const held = answers.filter((answer): answer is BotItemHeldAnswer => Boolean(answer))
  const images = held.reduce((count, answer) => count + answer.images.length, 0)
  if (images > AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
    return { kind: 'images', max: AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT }
  }
  const skills = new Set(held.flatMap((answer) => answer.skills.map(({ path }) => path)))
  return skills.size > MAX_SKILL_REFS ? { kind: 'skills', max: MAX_SKILL_REFS } : null
}

/** A held answer as its folded line reads: the words without its image marks or file pills, which
 *  show as themselves beside them. */
export function botItemHeldAnswerShown(answer: BotItemHeldAnswer): {
  words: string
  files: string[]
} {
  const { words, files } = botItemCommentFiles(answer.words)
  const shown = stripSentImagePromptMarkers(words, answer.images.length)
  return { words: shown.replace(/\s+/g, ' ').trim(), files }
}
