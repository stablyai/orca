// The open item's quick answers for a list beside its view (the Needs you inbox): the replies digits 1-9
// pick and the own-words reply. Both go through the view's own send path, as its chips and Type your
// answer do. Views outside such a list report nothing.
import { createContext, useContext, useEffect } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { BotItemQuickReply } from '../../../../../shared/bots/bot-item-ask'
import {
  botItemDigitReplies,
  botItemDigitReplyText
} from '../../../../../shared/bots/bot-item-digit-reply'
import { botItemWaitingAsk } from '../../../../../shared/bots/bot-item-question-answers'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import type { BotItemQuickReplyActions } from './use-bot-item-question-steps'

export type BotItemQuickAnswer = {
  uid: string
  /** What digits 1-9 pick, in order; empty while nothing can be picked (several questions, a send on
   *  its way, the ask not read yet). */
  replies: readonly BotItemQuickReply[]
  /** Posts digit `digit`'s reply; false when it picks nothing. */
  answer: (digit: number) => boolean
  /** Focuses the comment box to answer in your own words. */
  reply: () => void
}

/** Where an item view reports its quick answers; null (no list asks) reports nothing. */
export const BotItemQuickAnswerContext = createContext<
  ((answer: BotItemQuickAnswer | null) => void) | null
>(null)

/** `actions`: the view's quick replies, none for a deleted item; `pending`: its comments on their way. */
export function useBotItemQuickAnswerReport(
  item: BotItem,
  events: readonly BotItemEvent[],
  actions: BotItemQuickReplyActions | undefined,
  pending: readonly { failed?: boolean }[]
): void {
  const report = useContext(BotItemQuickAnswerContext)
  // It takes an answer only while none is on its way.
  const open = actions && !(actions.steps?.sending ?? pending.some(({ failed }) => !failed))
  const asked = report && open ? botItemWaitingAsk(item, events) : null
  const replies = botItemDigitReplies(asked)
  // Reported again only when what digits pick changes.
  const key = asked ? [asked.askId, ...replies.map((option) => option.label)].join('\0') : ''
  const currentReplies = useLatestHandler(() => replies)
  const answer = useLatestHandler((digit: number): boolean => {
    const text = botItemDigitReplyText(asked, digit)
    if (text === null) {
      return false
    }
    actions?.send(text)
    return true
  })
  const ownWords = useLatestHandler(() => actions?.type())
  const { uid } = item
  useEffect(() => {
    if (!report) {
      return undefined
    }
    report({ uid, replies: currentReplies(), answer, reply: ownWords })
    return () => report(null)
  }, [report, key, uid, currentReplies, answer, ownWords])
}
