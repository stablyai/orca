// An ask of several questions, all on one card: a quick reply, or the box's Enter on the line its
// "Replying to" names, picks the line's answer and sends nothing; Send posts the picks as one
// comment, so the agent wakes once. Picks are held on this device
// (the comment box's draft store, so a reload keeps them) until the host has the comment: one the host
// refused for a newer question stays to recover. Box words with files or skills, or with no line
// named, post at once and take the picks along. What each send answers is kept on its pending entry
// (`intent`), so its lines show as sent and can't be sent twice, whatever its words.
import { useCallback, useState, useSyncExternalStore } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotItem,
  BotItemCommentSkill,
  BotItemEvent
} from '../../../../../shared/bots/bot-items'
import type { BotItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import {
  botItemAnswersText,
  botItemAnswerWords,
  botItemRideAlongText
} from '../../../../../shared/bots/bot-item-answer-lines'
import {
  botItemAskLine,
  botItemWaitingAsk,
  botItemWaitingLine,
  type BotItemWaitingLine
} from '../../../../../shared/bots/bot-item-question-answers'
import { createBotItemReplyTargetHook } from '../../../../../shared/bots/use-bot-item-question-steps'
import type {
  BotItemPendingComment,
  BotItemPendingIntent
} from '../../../../../shared/bots/bot-item-pending-comments'
import { botItemSentAnswers } from '../../../../../shared/bots/bot-item-sent-answers'
import { botItemCommentFiles } from '../../../../../shared/bots/bot-item-comment-files'
import { botItemCommentDraftScope } from './bot-item-comment-draft'
import { botItemHeldAnswersScope, useBotItemHeldAnswers } from './bot-item-held-answers'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from '../../native-chat/drafts/native-chat-composer-draft-store'

const NO_ASK: BotItemQuestionShape = { body: '', decisions: [] }

const useBotItemReplyTarget = createBotItemReplyTargetHook({ useState })

export type BotItemQuestionSteps = {
  askId: string
  shape: BotItemQuestionShape
  /** Per line, the answer picked here and not sent yet; only on lines still open to a pick. */
  picks: readonly (string | null)[]
  /** The lines still open to a pick: no comment answered them, and no send of them is on its way. */
  lines: readonly number[]
  /** A quick reply: picks it, swaps it for the line's other pick, or clears it when picked. */
  pick: (index: number, words: string) => void
  /** Editing a line in the comment box takes it over: its pick goes, and the box answers it. */
  bind: (index: number) => void
  /** Send: the picks post as one comment. `empty`: none picked; `none`: no line is open. */
  send: () => 'sent' | 'empty' | 'none'
  /** No line open, and a send of them on its way (not failed): Send reads as sending until the read. */
  sending: boolean
}

export type BotItemQuickReplyActions = {
  send: (text: string) => void
  edit: (text: string) => void
  /** Into the box as a comment of its own, answering no line: answers held for an earlier ask. */
  recover: (text: string) => void
  /** Type your answer: the comment box takes focus, glowing once. */
  type: () => void
  /** The waiting ask of several questions, all its lines at once. */
  steps?: BotItemQuestionSteps | null
  /** Per ask, the answers of its sends on their way, by line. */
  sent?: ReadonlyMap<string, readonly (string | null)[]>
}

export function useBotItemQuestionSteps(
  bot: Bot,
  item: BotItem,
  events: readonly BotItemEvent[],
  /** `questionId`: the ask the text answers, so a reply that lands after a new question is refused;
   *  `plain`: it answers none; `intent`: what it answers, kept on this device. */
  send: (
    text: string,
    paths?: readonly string[],
    questionId?: string,
    plain?: boolean,
    skills?: readonly BotItemCommentSkill[],
    skipped?: readonly number[],
    intent?: BotItemPendingIntent
  ) => void,
  pending: readonly BotItemPendingComment[]
): {
  steps: BotItemQuestionSteps | null
  sent: ReadonlyMap<string, readonly (string | null)[]>
  /** A quick reply of one question, posted at once as it always has. */
  quick: (text: string) => void
  /** The comment box's send: it answers only the question its "Replying to" names; with none named
   *  (its × closed), the comment answers nothing. */
  fromBox: (
    text: string,
    paths: readonly string[],
    replyingTo: string | null,
    skills?: readonly BotItemCommentSkill[]
  ) => void
  /** The box's next draft answers no line: recovered answers of an earlier ask, a comment of its own. */
  answerNone: () => void
  /** Type your answer, or a quick reply's edit: the box answers the question offered, its words too. */
  answerWaiting: () => void
  /** What the comment box replies to: the line named when its draft started (shared with the phone). */
  waitingLine: BotItemWaitingLine | null
} {
  // As cheap as the box's own waiting-line read, on each render.
  const asked = botItemWaitingAsk(item, events)
  const waiting = asked && asked.shape.decisions.length > 1 ? asked : null
  const askId = waiting?.askId ?? ''
  const shape = waiting?.shape ?? NO_ASK
  // One question, or one in prose: the box names it until its × closes.
  const oneLine = waiting ? null : botItemWaitingLine(item, events)
  const heldScope = botItemHeldAnswersScope(bot, item.uid, askId)
  const { held, hold } = useBotItemHeldAnswers(heldScope, shape)
  const sent = botItemSentAnswers(pending)
  const sending = (waiting && sent.get(askId)) || null
  const skipping = pending.find(
    (entry) => entry.intent?.askId === askId && !entry.failed && entry.skipped?.length
  )?.skipped
  const boxScope = botItemCommentDraftScope(bot, item.uid)
  const subscribeBox = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(boxScope, listener),
    [boxScope]
  )
  // Words or an attachment alike start a draft.
  const boxEmpty = useSyncExternalStore(subscribeBox, () => {
    const box = readNativeChatComposerDraft(boxScope)
    return box.text.trim() === '' && box.images.length === 0
  })
  // Open to a pick: no comment answered it (a plain comment read by order gives way to a pick), and
  // no send of it is on its way.
  const lines = shape.decisions.flatMap((_, index) =>
    (!waiting?.answers[index] || (waiting.byOrder[index] && held[index])) &&
    !sending?.[index] &&
    !skipping?.includes(index)
      ? [index]
      : []
  )
  // A line another client answered meanwhile keeps that answer; its pick is dropped.
  const picks = shape.decisions.map((_, at) => (lines.includes(at) ? (held[at] ?? null) : null))
  const eligible = (index: number): boolean => lines.includes(index) && !picks[index]
  // The line the box's draft answers, taken when its first words arrived (typed, pasted, dictated or
  // restored alike: the box's draft store says). A one-question ask's line goes once its answer is
  // on its way.
  const open = waiting
    ? lines.filter(eligible).map((index) => botItemAskLine(askId, shape, index))
    : oneLine && !pending.some((entry) => !entry.failed && entry.intent?.askId === oneLine.eventId)
      ? [oneLine]
      : []
  const target = useBotItemReplyTarget(open, boxEmpty)
  // Stored picks: a line a comment answered by name loses its pick; one on its way keeps it, to
  // recover if the host refuses it.
  const stored = (index: number, words: string | null): (string | null)[] =>
    shape.decisions.map((_, at) => {
      if (at === index) {
        return words
      }
      return waiting?.answers[at] && !waiting.byOrder[at] ? null : (held[at] ?? null)
    })
  const post = (
    answers: (string | null)[],
    text: string,
    paths: readonly string[],
    skills?: readonly BotItemCommentSkill[],
    { skipped, rideAlongText }: { skipped?: readonly number[]; rideAlongText?: string } = {}
  ): void =>
    send(text, paths, askId, undefined, skills, skipped, { askId, shape, answers, rideAlongText })
  const pick = useLatestHandler((index: number, words: string) => {
    if (lines.includes(index)) {
      hold(stored(index, held[index] === words ? null : words))
    }
  })
  const bind = useLatestHandler((index: number) => {
    target.bind(`${askId}:${index}`)
    if (held[index]) {
      hold(stored(index, null))
    }
  })
  const sendPicks = useLatestHandler((): 'sent' | 'empty' | 'none' => {
    if (picks.some(Boolean)) {
      post(picks, botItemAnswersText(shape, picks), [], undefined, {
        skipped: lines.filter((index) => !picks[index])
      })
      return 'sent'
    }
    return lines.length > 0 ? 'empty' : 'none'
  })
  const fromBox = useLatestHandler(
    (
      text: string,
      paths: readonly string[],
      replyingTo: string | null,
      skills?: readonly BotItemCommentSkill[]
    ) => {
      target.release()
      if (!waiting) {
        // Naming the question it answers, so a reply that lands after the agent asked anew is
        // refused; else a comment of its own, never left for the host to take as an answer.
        const questionId =
          oneLine !== null && replyingTo === oneLine.id ? oneLine.eventId : undefined
        // Answering the one question: what it answers stays with the send.
        const intent =
          questionId !== undefined && asked
            ? {
                askId: asked.askId,
                shape: asked.shape,
                answers: asked.shape.decisions.map((_, index) =>
                  botItemAnswerWords(asked.shape, index, { text })
                )
              }
            : questionId !== undefined
              ? { askId: questionId, shape: NO_ASK, answers: [] }
              : undefined
        send(text, paths, questionId, questionId === undefined, skills, undefined, intent)
        return
      }
      const line = shape.decisions.findIndex((_, index) => replyingTo === `${askId}:${index}`)
      if (line !== -1 && eligible(line)) {
        if (
          paths.length === 0 &&
          (skills?.length ?? 0) === 0 &&
          botItemCommentFiles(text).files.length === 0
        ) {
          // Typed words wait like a pick: the line folds to them, the box names the next open line,
          // and Send posts them with the rest.
          hold(stored(line, text.replace(/\s+/g, ' ').trim()))
          return
        }
        // Files (attached, or named in the words as a file pill) and skills aren't held here: they
        // post now, with the picks so far. Images alone still name their line, by the marks chat
        // gives them, so the host can't pair them with another open line.
        const words = text.trim() || paths.map((_, at) => `[Image #${at + 1}]`).join(' ')
        const next = picks.map((held, at) => (at === line ? words : held))
        post(next, botItemAnswersText(shape, next), paths, skills)
      } else if (picks.some(Boolean)) {
        // The picks name their lines; the words ride along answering none.
        post(picks, botItemRideAlongText(shape, picks, text), paths, skills, {
          rideAlongText: text
        })
      } else {
        send(text, paths, undefined, true, skills)
      }
    }
  )
  const answerNone = useLatestHandler(() => target.none())
  const answerWaiting = useLatestHandler(() => {
    if (open[0]) {
      target.bind(open[0].id)
    }
  })
  // Read fresh each render, as the waiting ask is.
  const steps: BotItemQuestionSteps | null = waiting
    ? {
        askId,
        shape,
        picks,
        lines,
        pick,
        bind,
        send: sendPicks,
        sending:
          lines.length === 0 &&
          pending.some(({ failed, intent }) => !failed && intent?.askId === askId)
      }
    : null
  const quick = useLatestHandler((text: string) => {
    const intent = asked
      ? {
          askId: asked.askId,
          shape: asked.shape,
          answers: asked.shape.decisions.map((_, index) =>
            botItemAnswerWords(asked.shape, index, { text })
          )
        }
      : undefined
    send(text, [], asked?.askId, undefined, undefined, undefined, intent)
  })
  return {
    steps,
    sent,
    quick,
    fromBox,
    answerNone,
    answerWaiting,
    waitingLine: target.line
  }
}
