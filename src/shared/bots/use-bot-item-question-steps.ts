// An ask of several questions, one line at a time, on the phone (the desktop shows them all on one
// card, in its own use-bot-item-question-steps): a quick reply or the box's send answers the line it is
// on, and the step moves to the first open line. Answers, picked or
// typed, are held on this device (the app's draft store, keyed by `heldScope`) and post as one comment
// when the last line is answered, so the agent wakes once, or with "send anyway", which skips the
// lines still unanswered: they close, and the agent's mail names them. An
// answer with files or skills, and any other comment sent sooner, posts the held answers with it, so
// none is left only on this device.
import type * as React from 'react'
import type { BotItem, BotItemCommentSkill, BotItemEvent } from './bot-items'
import { botItemQuestionLine, type BotItemQuestionShape } from './bot-item-ask'
import {
  botItemAnswersText,
  botItemAnswerWords,
  botItemHeldAnswersText,
  botItemNamedAnswers
} from './bot-item-answer-lines'
import {
  botItemWaitingAsk,
  botItemWaitingLine,
  type BotItemWaitingLine
} from './bot-item-question-answers'
import type { BotItemPendingComment, BotItemPendingIntent } from './bot-item-pending-comments'

const NO_ASK: BotItemQuestionShape = { body: '', decisions: [] }

/** Where one ask's held answers live in the draft store: `itemScope` names the item on its host. */
export function botItemHeldAnswersScope(itemScope: string, askId: string): string {
  return `bot-item-answers:${itemScope}:${askId}`
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
  /** "send anyway": the held answers post as one comment; the other lines close as skipped. */
  sendHeld: () => void
}

export type BotItemQuickReplyActions = {
  send: (text: string) => void
  edit: (text: string) => void
  /** Into the box as a comment of its own, answering no line: answers held for an earlier ask. */
  recover: (text: string) => void
  /** Type your answer: the comment box takes focus, naming the question. */
  type: () => void
  /** The waiting ask of several questions, one line at a time. */
  steps?: BotItemQuestionSteps | null
  /** Answers just posted as one comment. */
  sent?: BotItemSentAnswers | null
}

/** Answers just posted as one comment: shown on their lines until the host's read has the comment.
 *  `intent` is the one its pending comment carries, which names that comment whatever its words. */
export type BotItemSentAnswers = {
  askId: string
  text: string
  answers: (string | null)[]
  intent: BotItemPendingIntent
}

/** `entry` is the comment `sent` posted, still on its way: by the intent it carries, so another
 *  comment with the same words (a plain "Yes" beside a card's) is never taken for it. */
export function isBotItemSentComment(
  entry: Pick<BotItemPendingComment, 'failed' | 'intent'>,
  sent: BotItemSentAnswers | null | undefined
): boolean {
  return !entry.failed && entry.intent !== undefined && entry.intent === sent?.intent
}

/** `questionId`: the ask the text answers, so a reply that lands after a new question is refused;
 *  `plain`: it answers none; `skipped`: that ask's lines it leaves unanswered, closing them; `intent`:
 *  what it answers, kept on this device, so a refusal gives back the right words. */
export type BotItemQuestionStepsSend = (
  text: string,
  paths?: readonly string[],
  questionId?: string,
  plain?: boolean,
  skills?: readonly BotItemCommentSkill[],
  skipped?: readonly number[],
  intent?: BotItemPendingIntent
) => void

export type BotItemQuestionStepsState = {
  steps: BotItemQuestionSteps | null
  sent: BotItemSentAnswers | null
  /** A quick reply of one question, posted at once as it always has; `answering`: the ask it answers
   *  when its event isn't read yet, and the lines it leaves unanswered, closing them. */
  quick: (text: string, answering?: { askId: string; skipped: readonly number[] }) => void
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
}

type HeldDraft = (scopeKey: string) => { draft: string; setDraft: (next: string) => void }

/** Built with each app's own React and draft store: the phone's bundle resolves `react` apart from
 *  this file's. */
export function createBotItemQuestionStepsHooks(
  {
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    useState
  }: Pick<typeof React, 'useCallback' | 'useLayoutEffect' | 'useMemo' | 'useRef' | 'useState'>,
  useHeldDraft: HeldDraft
) {
  /** A stable function calling the latest committed handler. */
  function useLatest<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
    const latest = useRef(handler)
    useLayoutEffect(() => {
      latest.current = handler
    })
    return useCallback((...args: A) => latest.current(...args), [])
  }

  /** An ask's answers held on this device, per question line, stored as the comment they post as. */
  function useBotItemHeldAnswers(
    scopeKey: string,
    shape: BotItemQuestionShape
  ): { held: (string | null)[]; hold: (answers: readonly (string | null)[]) => void } {
    const { draft, setDraft } = useHeldDraft(scopeKey)
    const held = useMemo(() => botItemNamedAnswers(shape, draft), [shape, draft])
    const hold = useCallback(
      (answers: readonly (string | null)[]) => setDraft(botItemHeldAnswersText(shape, answers)),
      [setDraft, shape]
    )
    return { held, hold }
  }

  function useBotItemQuestionSteps(
    /** The item on its host, which its asks' held answers are kept under. */
    itemScope: string,
    /** Null while the item is still being read. */
    item: BotItem | null,
    events: readonly BotItemEvent[],
    send: BotItemQuestionStepsSend,
    pending: readonly BotItemPendingComment[]
  ): BotItemQuestionStepsState {
    // As cheap as the box's own waiting-line read, on each render.
    const asked = item ? botItemWaitingAsk(item, events) : null
    const waiting = asked && asked.shape.decisions.length > 1 ? asked : null
    const askId = waiting?.askId ?? ''
    const shape = waiting?.shape ?? NO_ASK
    // One question, or one in prose: the box names it until its × closes.
    const oneLine = waiting || !item ? null : botItemWaitingLine(item, events)
    const { held, hold } = useBotItemHeldAnswers(botItemHeldAnswersScope(itemScope, askId), shape)
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
      skills?: readonly BotItemCommentSkill[],
      skipped?: readonly number[]
    ): void => {
      hold([])
      const intent = { askId, shape, answers }
      setSent({ askId, text, answers, intent })
      send(text, paths, askId, undefined, skills, skipped, intent)
    }
    // Typed words wait like a quick reply; files and skills aren't held here, so they post the answers so far.
    const settle = (
      index: number,
      words: string,
      fromBoxPaths?: readonly string[],
      skills?: readonly BotItemCommentSkill[]
    ): void => {
      const next = kept.map((held_, at) => (at === index ? words : held_))
      setChosen(null)
      if (
        (fromBoxPaths?.length ?? 0) > 0 ||
        (skills?.length ?? 0) > 0 ||
        lines.every((at) => next[at])
      ) {
        post(next, botItemAnswersText(shape, next), fromBoxPaths ?? [], skills)
        return
      }
      hold(next)
    }
    const answer = useLatest((index: number, words: string) => settle(index, words))
    const fromBox = useLatest(
      (
        text: string,
        paths: readonly string[],
        replyingTo: string | null,
        skills?: readonly BotItemCommentSkill[]
      ) => {
        if (!waiting) {
          // Naming the question it answers, so a reply that lands after the agent asked anew is refused.
          const answers =
            oneLine !== null && replyingTo === oneLine.id ? oneLine.eventId : undefined
          send(text, paths, answers, oneLine !== null && replyingTo === null, skills)
        } else if (replyingTo === `${askId}:${current}`) {
          settle(current, text, paths, skills)
        } else {
          // Held answers name their lines; the comment rides along answering none.
          const answered = botItemAnswersText(shape, kept)
          if (answered) {
            post(kept, `${answered}\n${text}`, paths, skills)
          } else {
            send(text, paths, undefined, true, skills)
          }
        }
      }
    )
    const go = useLatest((index: number) => setChosen({ askId, index }))
    const heldCount = kept.filter(Boolean).length
    const sendHeld = useLatest(() => {
      const answered = botItemAnswersText(shape, kept)
      if (answered) {
        setChosen(null)
        post(
          kept,
          answered,
          [],
          undefined,
          lines.filter((at) => !kept[at])
        )
      }
    })
    // Read fresh each render, as the waiting ask is.
    const steps = waiting
      ? { askId, shape, held, current, lines, go, answer, heldCount, sendHeld }
      : null
    const quick = useLatest(
      (text: string, answering?: { askId: string; skipped: readonly number[] }) => {
        let intent: BotItemPendingIntent | undefined
        if (asked) {
          const { shape: own } = asked
          // Several lines: only those the text names; a line it skips stays open until the read.
          const answers =
            own.decisions.length > 1
              ? botItemNamedAnswers(own, text)
              : [botItemAnswerWords(own, 0, { text })]
          intent = { askId: asked.askId, shape: own, answers }
          setSent({ askId: asked.askId, text, answers, intent })
        }
        send(
          text,
          [],
          asked?.askId ?? answering?.askId,
          undefined,
          undefined,
          answering?.skipped,
          intent
        )
      }
    )
    const stepLine = steps?.shape.decisions[steps.current]
    return {
      steps,
      // Shown on their lines while their comment is on its way; a refused or discarded one shows as itself.
      sent: sent && pending.some((entry) => isBotItemSentComment(entry, sent)) ? sent : null,
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

  return { useBotItemHeldAnswers, useBotItemQuestionSteps }
}
