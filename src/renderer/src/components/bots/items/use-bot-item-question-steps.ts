// An ask of several questions, one line at a time: a quick reply or the box's Enter answers the line
// it is on, and the step moves to the first open line. Quick replies are held on this device (the
// comment box's draft store, so a reload keeps them) and post as one comment when the last line is
// answered, so the agent wakes once, or when the owner sends them sooner. Words sent from the box post
// at once, as any send does, and any other comment sent sooner posts the held answers with it, so none
// is left only on this device.
import { useCallback, useMemo, useState } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotItem,
  BotItemCommentSkill,
  BotItemEvent
} from '../../../../../shared/bots/bot-items'
import {
  botItemPickedReplies,
  botItemQuestionLine,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import {
  botItemAnswersText,
  botItemAnswerWords,
  botItemNamedAnswers
} from '../../../../../shared/bots/bot-item-answer-lines'
import {
  botItemQuestionPairing,
  botItemWaitingAsk,
  botItemWaitingLine,
  type BotItemWaitingLine
} from '../../../../../shared/bots/bot-item-question-answers'
import type { BotItemPendingComment } from '../../../../../shared/bots/bot-item-pending-comments'
import { useNativeChatDraft } from '../../native-chat/drafts/use-native-chat-draft'

const NOT_COMPOSING = (): boolean => false
const NO_ASK: BotItemQuestionShape = { body: '', decisions: [] }

export function botItemHeldAnswersScope(bot: Bot, itemUid: string, askId: string): string {
  return `bot-item-answers:${botRefKey(bot)}:${itemUid}:${askId}`
}

/** An ask's answers held on this device, per question line, stored as the comment they post as. */
export function useBotItemHeldAnswers(
  scopeKey: string,
  shape: BotItemQuestionShape
): { held: (string | null)[]; hold: (answers: readonly (string | null)[]) => void } {
  const { draft, setDraft } = useNativeChatDraft(scopeKey, NOT_COMPOSING)
  const held = useMemo(() => botItemNamedAnswers(shape, draft), [shape, draft])
  const hold = useCallback(
    (answers: readonly (string | null)[]) => setDraft(botItemAnswersText(shape, answers)),
    [setDraft, shape]
  )
  return { held, hold }
}

export type BotItemQuestionSteps = {
  askId: string
  shape: BotItemQuestionShape
  /** Per line, the answer held here until the set posts. */
  held: readonly (string | null)[]
  /** The line shown, by its index in the ask. */
  current: number
  /** The lines to step through: those no comment answered yet, or only by order while held here. */
  lines: readonly number[]
  go: (index: number) => void
  /** A quick reply: held until the last line is answered. */
  answer: (index: number, words: string) => void
  /** How many open lines hold an answer here, not sent yet. */
  heldCount: number
  /** "send anyway": the held answers post as one comment; the other lines stay open. */
  sendHeld: () => void
}

export type BotItemQuickReplyActions = {
  /** `askId`: the ask whose quick reply it is. */
  send: (text: string, askId: string) => void
  /** Into the box; `ask.named` names its question, for when the box replies to another ask's line. */
  edit: (text: string, ask?: { askId: string; named: string }) => void
  /** Into the box as a comment of its own, answering no line: answers held for an earlier ask. */
  recover: (text: string) => void
  /** Type your answer: the comment box takes focus, glowing once. */
  type: () => void
  /** The waiting ask of several questions, one line at a time. */
  steps?: BotItemQuestionSteps | null
  /** Answers just posted as one comment. */
  sent?: BotItemSentAnswers | null
}

/** Answers just posted as one comment: shown on their lines until the host's read has the comment. */
export type BotItemSentAnswers = { askId: string; text: string; answers: (string | null)[] }

export function useBotItemQuestionSteps(
  bot: Bot,
  item: BotItem,
  events: readonly BotItemEvent[],
  /** `questionId`: the ask the text answers, so a reply that lands after a new question is refused;
   *  `plain`: it answers none. */
  send: (
    text: string,
    paths?: readonly string[],
    questionId?: string,
    plain?: boolean,
    skills?: readonly BotItemCommentSkill[]
  ) => void,
  pending: readonly BotItemPendingComment[]
): {
  steps: BotItemQuestionSteps | null
  sent: BotItemSentAnswers | null
  /** A quick reply of one question, posted at once as it always has. */
  quick: (text: string, askId: string) => void
  /** The comment box's send: it answers only the question its "Replying to" names; with none named
   *  (its × closed), the comment answers nothing. */
  fromBox: (
    text: string,
    paths: readonly string[],
    replyingTo: string | null,
    skills?: readonly BotItemCommentSkill[]
  ) => void
  /** What the comment box replies to: with several questions, the line the step is on. */
  waitingLine: BotItemWaitingLine | null
} {
  // As cheap as the box's own waiting-line read, on each render.
  const asked = botItemWaitingAsk(item, events)
  const waiting = asked && asked.shape.decisions.length > 1 ? asked : null
  const askId = waiting?.askId ?? ''
  const shape = waiting?.shape ?? NO_ASK
  // One question, or one in prose: the box names it until its × closes.
  const oneLine = waiting ? null : botItemWaitingLine(item, events)
  const { held, hold } = useBotItemHeldAnswers(botItemHeldAnswersScope(bot, item.uid, askId), shape)
  const [chosen, setChosen] = useState<{ askId: string; index: number } | null>(null)
  const [sent, setSent] = useState<BotItemSentAnswers | null>(null)
  // A plain comment read by order took a line whose answer is held here: the held answer stands.
  const lines = shape.decisions.flatMap((_, index) =>
    !waiting?.answers[index] || (waiting.byOrder[index] && held[index]) ? [index] : []
  )
  const firstOpen = lines.find((index) => !held[index]) ?? lines[0] ?? 0
  const current =
    chosen && chosen.askId === askId && lines.includes(chosen.index) ? chosen.index : firstOpen
  // A line another client answered meanwhile keeps that answer; its held one is dropped.
  const kept = shape.decisions.map((_, at) => (lines.includes(at) ? (held[at] ?? null) : null))
  const post = (
    answers: (string | null)[],
    text: string,
    paths: readonly string[],
    skills?: readonly BotItemCommentSkill[]
  ): void => {
    hold([])
    setSent({ askId, text, answers })
    send(text, paths, askId, undefined, skills)
  }
  // A composer submission sends immediately, even when it carries no files or skills.
  const settle = (
    index: number,
    words: string,
    fromBoxPaths?: readonly string[],
    skills?: readonly BotItemCommentSkill[]
  ): void => {
    const next = kept.map((held_, at) => (at === index ? words : held_))
    setChosen(null)
    if (fromBoxPaths !== undefined || lines.every((at) => next[at])) {
      post(next, botItemAnswersText(shape, next), fromBoxPaths ?? [], skills)
      return
    }
    hold(next)
  }
  const answer = useLatestHandler((index: number, words: string) => settle(index, words))
  // Every line of the text answers a question another waiting ask holds.
  const namesOtherAsk = (text: string): boolean => {
    const others = [...botItemQuestionPairing(item, events).questions]
      .filter(([id, entry]) => id !== askId && entry.waiting)
      .flatMap(([, entry]) =>
        entry.shape.decisions.map((d) => `${botItemQuestionLine(d.question)} →`)
      )
    const lines = text.split('\n').filter((line) => line.trim())
    return (
      lines.length > 0 && lines.every((line) => others.some((head) => line.trim().startsWith(head)))
    )
  }
  const fromBox = useLatestHandler(
    (
      text: string,
      paths: readonly string[],
      replyingTo: string | null,
      skills?: readonly BotItemCommentSkill[]
    ) => {
      if (!waiting) {
        send(text, paths, undefined, oneLine !== null && replyingTo === null, skills)
      } else if (replyingTo === `${askId}:${current}` && !namesOtherAsk(text)) {
        settle(current, text, paths, skills)
      } else {
        // Held answers name their lines; the comment rides along answering none, or the other ask's
        // lines it names ("Question → answer", as an Alt-clicked chip of that ask fills the box).
        const answered = botItemAnswersText(shape, kept)
        if (answered) {
          post(kept, `${answered}\n${text}`, paths, skills)
        } else {
          send(text, paths, undefined, !namesOtherAsk(text), skills)
        }
      }
    }
  )
  const go = useLatestHandler((index: number) => setChosen({ askId, index }))
  const heldCount = kept.filter(Boolean).length
  const sendHeld = useLatestHandler(() => {
    const answered = botItemAnswersText(shape, kept)
    if (answered) {
      setChosen(null)
      post(kept, answered, [])
    }
  })
  // Read fresh each render, as the waiting ask is.
  const steps = waiting
    ? { askId, shape, held, current, lines, go, answer, heldCount, sendHeld }
    : null
  const quick = useLatestHandler((text: string, quickAskId: string) => {
    const own = botItemQuestionPairing(item, events).questions.get(quickAskId)?.shape
    if (own) {
      const picked = botItemPickedReplies(own, { text })
      const answers = own.decisions.map((_, index) =>
        picked[index]?.length ? botItemAnswerWords(own, index, { text }) : null
      )
      setSent({ askId: quickAskId, text, answers })
    }
    send(text, [], quickAskId)
  })
  const stepLine = steps?.shape.decisions[steps.current]
  return {
    steps,
    // Shown on their lines while their comment is on its way; a refused or discarded one shows as itself.
    sent:
      sent && pending.some(({ event, failed }) => !failed && event.data.text === sent.text)
        ? sent
        : null,
    quick,
    fromBox,
    waitingLine: stepLine
      ? {
          id: `${askId}:${steps.current}`,
          eventId: askId,
          line: botItemQuestionLine(stepLine.question),
          replies: stepLine.replies.length > 0
        }
      : oneLine
  }
}
