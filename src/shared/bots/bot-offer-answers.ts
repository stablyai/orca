// What the owner answered on a bot's offer cards, card by card. Kept on the bot, so a card reads its own answer
// after a reload or on another device, and one card's answer never touches another's.
import * as z from 'zod'

export const BotOfferAnswerSchema = z.object({
  /** The transcript row the card is drawn on. */
  cardId: z.string().min(1).max(512),
  /** The owner pressed Dismiss. */
  dismissed: z.literal(true).optional(),
  /** The owner took the card's action, on these: workspace ids, or import item indices. */
  sent: z.object({ chosen: z.array(z.string().min(1).max(4096)).max(64) }).optional()
})

export type BotOfferAnswer = z.infer<typeof BotOfferAnswerSchema>

/** `bots.offer.answer`: a press on an offer card, which the bot hears as a card answer queued behind its running turn. */
export const BotOfferAnswerParams = z.object({
  botId: z.string().min(1, 'Missing bot id'),
  /** The chat the card sits in; the bot's Chat when absent. */
  sessionId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(100_000)
})

/** What Not now tells the bot, in the words its create-offer result promised. */
export const BOT_OFFER_DISMISS_ANSWER = 'Dismiss'

const BOT_OFFER_ANSWER_FIELDS = ['dismissed', 'sent'] as const
type BotOfferAnswerField = (typeof BOT_OFFER_ANSWER_FIELDS)[number]

/** `bots.update`'s `offerAnswer`: an answer, written only while its fields are unanswered when `claim` is set, or
 *  `release`, which takes a field back off after its send was refused. */
export const BotOfferAnswerUpdateSchema = BotOfferAnswerSchema.extend({
  claim: z.literal(true).optional(),
  release: z.enum(BOT_OFFER_ANSWER_FIELDS).optional()
})

export type BotOfferAnswerUpdate = z.infer<typeof BotOfferAnswerUpdateSchema>

/** A claim lost to another window, device or press: that one sends, this one doesn't. */
export const BOT_OFFER_ALREADY_ANSWERED = 'bot_offer_already_answered'

/** `update` merged into the card's own entry. Never trimmed: a card whose answer went would open again.
 *  Throws BOT_OFFER_ALREADY_ANSWERED, saving nothing, when a claim comes after the card was answered. */
export function withBotOfferAnswer(
  answers: readonly BotOfferAnswer[] | undefined,
  { claim, release, ...answer }: BotOfferAnswerUpdate
): BotOfferAnswer[] {
  const previous = answers?.find((entry) => entry.cardId === answer.cardId)
  // A taken action answers the card for good; a Dismiss still leaves the action to take later.
  if (claim && (previous?.sent || (answer.dismissed && previous?.dismissed))) {
    throw new Error(BOT_OFFER_ALREADY_ANSWERED)
  }
  const next: BotOfferAnswer = { ...previous, ...answer }
  if (release) {
    delete next[release]
  }
  const others = (answers ?? []).filter((entry) => entry.cardId !== answer.cardId)
  return [...others, next]
}

/** How one press on an offer card ended. */
export type BotOfferAnswerOutcome = 'sent' | 'already_answered' | 'refused'

/** One press on an offer card, on any client: claim the answer on the host, so only one window, device or press
 *  tells the bot, then send it. A refused send gives the claim back, so the card can be pressed again. */
export async function answerBotOffer(
  answer: BotOfferAnswer & ({ dismissed: true } | { sent: NonNullable<BotOfferAnswer['sent']> }),
  ops: {
    /** `bots.update` with this `offerAnswer`. */
    update: (offerAnswer: BotOfferAnswerUpdate) => Promise<unknown>
    /** Tells the bot; false when the chat refused it. */
    send: () => Promise<boolean>
    /** The send threw after it may have reached the host (a lost reply): the claim stays, so a second
     *  press can't tell the bot twice. */
    deliveryUnknown?: (error: unknown) => boolean
  }
): Promise<BotOfferAnswerOutcome> {
  const field: BotOfferAnswerField = answer.sent ? 'sent' : 'dismissed'
  try {
    await ops.update({ ...answer, claim: true })
  } catch (error) {
    if (error instanceof Error && error.message === BOT_OFFER_ALREADY_ANSWERED) {
      return 'already_answered'
    }
    throw error
  }
  let sent = false
  let maybeSent = false
  try {
    sent = await ops.send()
  } catch (error) {
    maybeSent = ops.deliveryUnknown?.(error) === true
    throw error
  } finally {
    if (!sent && !maybeSent) {
      await ops.update({ cardId: answer.cardId, release: field })
    }
  }
  return sent ? 'sent' : 'refused'
}

/**
 * A further action on a card already answered with one (another account added from a Connected card):
 * its own press, so it takes no claim; it replaces the card's answer and tells the bot. A refused send
 * puts the previous answer back.
 */
export async function answerBotOfferAgain(
  answer: { cardId: string; sent: NonNullable<BotOfferAnswer['sent']> },
  previous: BotOfferAnswer['sent'],
  ops: {
    update: (offerAnswer: BotOfferAnswerUpdate) => Promise<unknown>
    send: () => Promise<boolean>
  }
): Promise<Exclude<BotOfferAnswerOutcome, 'already_answered'>> {
  await ops.update(answer)
  let sent = false
  try {
    sent = await ops.send()
  } finally {
    if (!sent) {
      await ops.update(
        previous
          ? { cardId: answer.cardId, sent: previous }
          : { cardId: answer.cardId, release: 'sent' }
      )
    }
  }
  return sent ? 'sent' : 'refused'
}
