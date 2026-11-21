// An ask of several questions, one line at a time: a quick reply or the box's Enter answers the line
// it is on, and the step moves to the first open line. Answers, images too, are held on this device
// (bot-item-held-answers) and show as your own card, not sent yet. They post as one comment when the
// last line is answered or on Send now, so the agent wakes once; lines left open post later as a
// comment of their own. Any comment sent sooner (a comment of its own) posts the held answers with
// it, and the agent asking again posts those of the ask it replaced, so none is left only on this
// device. A comment still on its way answers its lines already.
import { useEffect, useState } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import {
  botItemQuestionLine,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import {
  botItemAnswerBatches,
  botItemAnswersComment,
  botItemLineImages,
  type BotItemHeldAnswer
} from '../../../../../shared/bots/bot-item-answer-lines'
import {
  botItemQuestionPairing,
  botItemWaitingLine,
  type BotItemQuestionAnswers
} from '../../../../../shared/bots/bot-item-question-answers'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../../../../../shared/agent-session/agent-session-attachments'
import { offsetSentImagePromptMarkers } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import type { BotItemPendingComment } from './use-bot-item-pending-comments'
import {
  botItemHeldAnswerScope,
  holdBotItemAnswer,
  readBotItemHeldAnswer,
  useBotItemHeldAnswers
} from './bot-item-held-answers'

const NO_ASK: BotItemQuestionShape = { body: '', decisions: [] }

export type BotItemQuestionSteps = {
  askId: string
  shape: BotItemQuestionShape
  /** Per line, the answer held here until it posts. */
  held: readonly (BotItemHeldAnswer | null)[]
  /** The line shown, by its index in the ask. */
  current: number
  /** The lines to step through: those no comment answered yet, or only by order while held here. */
  lines: readonly number[]
  go: (index: number) => void
  answer: (index: number, words: string, paths?: readonly string[]) => void
  /** A held answer back into the box to change, the box replying to its line until it sends. */
  edit: (index: number) => void
  /** Posts the answers held so far; lines still open stay open. */
  sendNow: () => void
}

export type BotItemQuickReplyActions = {
  send: (text: string) => void
  /** Into the box to change, with the images its [Image #N] name. */
  edit: (text: string, paths?: readonly string[]) => void
  /** Into the box as a comment of its own, answering no line: an answer held for a closed item. */
  recover: (text: string, paths: readonly string[]) => void
  /** Type your answer: the comment box takes focus, glowing once. */
  type: () => void
  /** The waiting ask of several questions, one line at a time. */
  steps?: BotItemQuestionSteps | null
}

type Ask = { askId: string; entry: BotItemQuestionAnswers }

export function useBotItemQuestionSteps(
  bot: Bot,
  item: BotItem,
  events: readonly BotItemEvent[],
  /** `questionId`: the ask the text answers, so a reply that lands after a new question is refused. */
  send: (text: string, paths?: readonly string[], questionId?: string) => void,
  pending: readonly BotItemPendingComment[],
  /** Opens the comment box on a held answer's words and images. */
  fill: (text: string, paths: readonly string[]) => void
): {
  steps: BotItemQuestionSteps | null
  quick: (text: string) => void
  /** The comment box's send: "Replying to" a line of several questions, it answers that line. */
  fromBox: (text: string, paths: readonly string[], replyingTo: string | null) => void
  /** What the comment box replies to: with several questions, the line the step is on. */
  waitingLine: { id: string; line: string; replies: boolean; editing?: boolean } | null
} {
  // A comment on its way answers its lines already. A refused one answers nothing until it is sent again.
  const sending = pending.flatMap(({ event, failed }) => (failed ? [] : [event]))
  const all = sending.length > 0 ? [...events, ...sending] : events
  const questions = botItemQuestionPairing(item, all).questions
  // The ask a quick reply answers, of one question or several.
  const asked = [...questions].find(([, entry]) => entry.waiting)?.[0]
  const asks: Ask[] = [...questions].flatMap(([askId, entry]) =>
    entry.shape.decisions.length > 1 ? [{ askId, entry }] : []
  )
  const scope = (askId: string, line: number): string =>
    botItemHeldAnswerScope(bot, item.uid, askId, line)
  const stored = useBotItemHeldAnswers(
    asks.flatMap(({ askId, entry }) => entry.shape.decisions.map((_, line) => scope(askId, line)))
  )
  const storedOf = (ask: Ask): readonly (BotItemHeldAnswer | null)[] => {
    const start = asks
      .slice(0, asks.indexOf(ask))
      .reduce((sum, { entry }) => sum + entry.shape.decisions.length, 0)
    return stored.slice(start, start + ask.entry.shape.decisions.length)
  }
  const waiting = asks.find(({ entry }) => entry.waiting) ?? null
  const askId = waiting?.askId ?? ''
  const shape = waiting?.entry.shape ?? NO_ASK
  const own = waiting ? storedOf(waiting) : []
  const [chosen, setChosen] = useState<{ askId: string; index: number } | null>(null)
  const [editing, setEditing] = useState<{
    askId: string
    shape: BotItemQuestionShape
    index: number
  } | null>(null)
  // A plain comment read by order took a line whose answer is held here: the held answer stands.
  const lines = shape.decisions.flatMap((_, index) =>
    !waiting?.entry.answers[index] || (waiting.entry.byOrder[index] && own[index]) ? [index] : []
  )
  // A line another client answered meanwhile keeps that answer; its held one is dropped.
  const held = shape.decisions.map((_, at) => (lines.includes(at) ? (own[at] ?? null) : null))
  const firstOpen = lines.find((index) => !held[index]) ?? lines[0] ?? 0
  const pinned = editing?.askId === askId ? editing : chosen?.askId === askId ? chosen : null
  const current = pinned && lines.includes(pinned.index) ? pinned.index : firstOpen
  const release = (id: string, ask: BotItemQuestionShape): void =>
    ask.decisions.forEach((_, line) => holdBotItemAnswer(scope(id, line), null))
  // Whole lines per comment, under the host's image cap; the box's own comment goes with the last.
  const post = (
    ask: BotItemQuestionShape,
    answers: readonly (BotItemHeldAnswer | null)[],
    typed?: { text: string; paths: readonly string[] },
    questionId?: string
  ): void => {
    const batches = botItemAnswerBatches(ask, answers, AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT)
    let rest = typed
    for (const [at, batch] of batches.entries()) {
      const comment = botItemAnswersComment(ask, batch)
      const joins =
        rest &&
        at === batches.length - 1 &&
        comment.paths.length + rest.paths.length <= AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT
      if (rest && joins) {
        // The comment's own images come after the answers'.
        const words = offsetSentImagePromptMarkers(
          rest.text,
          rest.paths.length,
          comment.paths.length
        )
        send(`${comment.text}\n${words}`, [...comment.paths, ...rest.paths], questionId)
        rest = undefined
      } else {
        send(comment.text, comment.paths, questionId)
      }
    }
    if (rest) {
      send(rest.text, rest.paths, questionId)
    }
  }
  // The agent asked again (or stopped waiting) with answers still held here: they post once, against
  // the ask they answer. A line another client named meanwhile keeps that answer.
  const closed = item.status === 'done' || item.status === 'canceled'
  const replaced = closed
    ? []
    : asks.filter((ask) => !ask.entry.waiting && storedOf(ask).some(Boolean))
  const flushKey = replaced.map(({ askId: id }) => id).join('\n')
  const flush = useLatestHandler(() => {
    for (const { askId: id, entry } of replaced) {
      // Read again: what an earlier run of this posted is gone.
      const kept = entry.shape.decisions.map((_, line) => {
        const answer = readBotItemHeldAnswer(scope(id, line))
        return answer && (!entry.answers[line] || entry.byOrder[line]) ? answer : null
      })
      release(id, entry.shape)
      if (kept.some(Boolean)) {
        // Not bound to that ask: it lands after the agent's new question on purpose.
        post(entry.shape, kept)
      }
    }
  })
  useEffect(() => {
    if (flushKey) {
      flush()
    }
  }, [flushKey, flush])
  const answer = useLatestHandler((index: number, typed: string, paths: readonly string[] = []) => {
    const words = withEveryImageMarked(typed, paths.length)
    const next = held.map((answer_, at) => (at === index ? { words, paths } : answer_))
    setChosen(null)
    setEditing(null)
    if (lines.every((at) => next[at])) {
      release(askId, shape)
      post(shape, next, undefined, askId)
      return
    }
    holdBotItemAnswer(scope(askId, index), { words, paths })
  })
  const fromBox = useLatestHandler(
    (text: string, paths: readonly string[], replyingTo: string | null) => {
      const edited = editing && replyingTo === `${editing.askId}:${editing.index}` ? editing : null
      setEditing(null)
      const target =
        waiting && replyingTo?.startsWith(`${askId}:`)
          ? Number(replyingTo.slice(askId.length + 1))
          : null
      if (target !== null && lines.includes(target)) {
        answer(target, text, paths)
      } else if (edited) {
        // Its line was sent meanwhile (Send now, another device): this corrects it, by its line.
        const words = withEveryImageMarked(text, paths.length)
        const comment = botItemAnswersComment(
          edited.shape,
          edited.shape.decisions.map((_, at) => (at === edited.index ? { words, paths } : null))
        )
        send(comment.text, comment.paths)
      } else if (waiting && held.some(Boolean)) {
        release(askId, shape)
        post(shape, held, { text, paths }, askId)
      } else {
        send(text, paths)
      }
    }
  )
  const go = useLatestHandler((index: number) => {
    setEditing(null)
    setChosen({ askId, index })
  })
  const edit = useLatestHandler((index: number) => {
    const answer_ = held[index]
    if (!answer_) {
      return
    }
    setChosen({ askId, index })
    setEditing({ askId, shape, index })
    fill(answer_.words, answer_.paths)
  })
  const sendNow = useLatestHandler(() => {
    if (held.some(Boolean)) {
      release(askId, shape)
      post(shape, held, undefined, askId)
    }
  })
  // A quick reply of a single question, bound to its ask.
  const quick = useLatestHandler((text: string) => send(text, [], asked))
  // Read fresh each render, as the waiting ask is.
  const steps =
    waiting && lines.length > 0
      ? { askId, shape, held, current, lines, go, answer, edit, sendNow }
      : null
  const stepLine = steps?.shape.decisions[steps.current]
  // An edit replies to its own line, even once that line is sent.
  const editLine =
    editing && !(steps && editing.askId === askId && lines.includes(editing.index))
      ? editing.shape.decisions[editing.index]
      : undefined
  return {
    steps,
    quick,
    fromBox,
    waitingLine:
      editing && editLine
        ? {
            id: `${editing.askId}:${editing.index}`,
            line: botItemQuestionLine(editLine.question),
            replies: false,
            editing: true
          }
        : stepLine
          ? {
              id: `${askId}:${steps.current}`,
              line: botItemQuestionLine(stepLine.question),
              replies: stepLine.replies.length > 0
            }
          : botItemWaitingLine(item, all)
  }
}

/** An image whose [Image #N] was deleted from the words still goes with this line: its mark is added
 *  at the end, so the line names every image it sends. */
function withEveryImageMarked(words: string, imageCount: number): string {
  const named = new Set(botItemLineImages(words, imageCount))
  const missing = Array.from({ length: imageCount }, (_, at) => at).filter((at) => !named.has(at))
  return [words.trim(), ...missing.map((at) => `[Image #${at + 1}]`)].filter(Boolean).join(' ')
}
