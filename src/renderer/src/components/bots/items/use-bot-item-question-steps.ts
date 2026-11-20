// An ask of several questions, one line at a time: a quick reply or the box's Enter answers the line
// it is on, and the step moves to the first open line. Answers are held on this device (the comment
// box's draft store, so a reload keeps them) and post as one comment when the last line is answered,
// so the agent wakes once.
import { useCallback, useMemo, useState } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import type { BotItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import {
  botItemAnswersText,
  botItemAnswerWords,
  botItemNamedAnswers
} from '../../../../../shared/bots/bot-item-answer-lines'
import {
  botItemQuestionPairing,
  type BotItemQuestionAnswers
} from '../../../../../shared/bots/bot-item-question-answers'
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

function waitingAsk(
  item: BotItem,
  events: readonly BotItemEvent[]
): ({ askId: string } & BotItemQuestionAnswers) | null {
  for (const [askId, entry] of botItemQuestionPairing(item, events).questions) {
    if (entry.waiting) {
      return { askId, ...entry }
    }
  }
  return null
}

export type BotItemQuestionSteps = {
  askId: string
  shape: BotItemQuestionShape
  /** Per line, the answer held here until the set posts. */
  held: readonly (string | null)[]
  /** The line shown, by its index in the ask. */
  current: number
  /** The lines to step through: those no comment answered yet. */
  lines: readonly number[]
  go: (index: number) => void
  answer: (index: number, words: string) => void
}

export type BotItemQuickReplyActions = {
  send: (text: string) => void
  edit: (text: string) => void
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
  send: (text: string) => void
): {
  steps: BotItemQuestionSteps | null
  sent: BotItemSentAnswers | null
  /** A quick reply of one question, posted at once as it always has. */
  quick: (text: string) => void
} {
  // As cheap as the box's own waiting-line read, on each render.
  const asked = waitingAsk(item, events)
  const waiting = asked && asked.shape.decisions.length > 1 ? asked : null
  const askId = waiting?.askId ?? ''
  const shape = waiting?.shape ?? NO_ASK
  const { held, hold } = useBotItemHeldAnswers(botItemHeldAnswersScope(bot, item.uid, askId), shape)
  const [chosen, setChosen] = useState<{ askId: string; index: number } | null>(null)
  const [sent, setSent] = useState<BotItemSentAnswers | null>(null)
  const lines = useMemo(
    () => shape.decisions.flatMap((_, index) => (waiting?.answers[index] ? [] : [index])),
    [shape, waiting]
  )
  const firstOpen = lines.find((index) => !held[index]) ?? lines[0] ?? 0
  const current =
    chosen && chosen.askId === askId && lines.includes(chosen.index) ? chosen.index : firstOpen
  const answer = useLatestHandler((index: number, words: string) => {
    const next = shape.decisions.map((_, at) => (at === index ? words : (held[at] ?? null)))
    setChosen(null)
    if (lines.every((at) => next[at])) {
      const text = botItemAnswersText(shape, next)
      hold([])
      setSent({ askId, text, answers: next })
      send(text)
      return
    }
    hold(next)
  })
  const go = useCallback((index: number) => setChosen({ askId, index }), [askId])
  const steps = useMemo(
    () => (waiting ? { askId, shape, held, current, lines, go, answer } : null),
    [waiting, askId, shape, held, current, lines, go, answer]
  )
  const quick = useLatestHandler((text: string) => {
    if (asked) {
      const { shape: own } = asked
      const answers = own.decisions.map((_, index) => botItemAnswerWords(own, index, { text }))
      setSent({ askId: asked.askId, text, answers })
    }
    send(text)
  })
  return { steps, sent, quick }
}
