import type { BotOfferAnswer } from '../../../shared/bots/bot-offer-answers'
import { publishBots, readHostBots } from './bot-catalog-snapshot'
import type { BotRef } from './bot-hosts'

/** Shows a card answer the host already saved, without waiting on a re-read that an update in flight
 *  would hold back. */
export function publishBotOfferAnswer(target: BotRef, answer: BotOfferAnswer): void {
  const { hostId } = target
  publishBots(
    readHostBots(hostId).map((entry) =>
      entry.id === target.id
        ? {
            ...entry,
            offerAnswers: [
              ...(entry.offerAnswers ?? []).filter((saved) => saved.cardId !== answer.cardId),
              answer
            ]
          }
        : entry
    ),
    undefined,
    hostId
  )
}
