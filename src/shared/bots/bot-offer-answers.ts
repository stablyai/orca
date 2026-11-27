import { lazyZodSchema } from '../schema/lazy-zod-schema'
// What the owner answered on a bot's offer cards, card by card. Kept on the bot, so a card reads its own answer
// after a reload or on another device, and one card's answer never touches another's.
import * as z from 'zod'

const BotOfferChosenSchema = lazyZodSchema(() => z.array(z.string().min(1).max(4096)).max(64))

export const BotOfferAnswerSchema = lazyZodSchema(() =>
  z.object({
    /** The transcript row the card is drawn on. */
    cardId: z.string().min(1).max(512),
    /** The owner pressed Dismiss. */
    dismissed: z.literal(true).optional(),
    /** The owner took the card's action, on these: workspace ids, or import item indices. */
    sent: z.object({ chosen: BotOfferChosenSchema }).optional(),
    /** How many further actions the card took after its first (`answerBotOfferAgain`); each one keys its
     *  own card answer, so a retry of it reuses that key and a later one gets the next. */
    revision: z.number().int().min(0).max(1_000_000).optional()
  })
)

export type BotOfferAnswer = z.infer<typeof BotOfferAnswerSchema>

/** The same for every attempt at one card answer (`botOfferAnswerKey`): a host that already queued it
 *  returns that answer again, so a retry after a lost reply never tells the bot twice. */
export const BotOfferAnswerKeySchema = lazyZodSchema(() => z.string().min(1).max(1024))

/** `bots.offer.answer`: a press on an offer card, which the bot hears as a card answer queued behind its running turn. */
export const BotOfferAnswerParams = lazyZodSchema(() =>
  z.object({
    botId: z.string().min(1, 'Missing bot id'),
    /** The chat the card sits in; the bot's Chat when absent. */
    sessionId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(100_000),
    answerKey: BotOfferAnswerKeySchema.optional(),
    /** What this answer chose, so a repeat under `answerKey` hears back what the bot was told. */
    chosen: BotOfferChosenSchema.optional()
  })
)

/** What the host did with one card answer. `chosen`: what the bot was told for its answer key, which
 *  is an earlier answer's choice when this one repeated it. */
export type BotOfferTold = { sent: boolean; chosen?: readonly string[] }

/** What Not now tells the bot, in the words its create-offer result promised. */
export const BOT_OFFER_DISMISS_ANSWER = 'Dismiss'

const BOT_OFFER_ANSWER_FIELDS = ['dismissed', 'sent'] as const
type BotOfferAnswerField = (typeof BOT_OFFER_ANSWER_FIELDS)[number]

/** `bots.update`'s `offerAnswer`: an answer, written only while its fields are unanswered when `claim` is set, or
 *  `release`, which takes a field back off after its send was refused. With `ifRevision`, written only while
 *  the card is still at that revision, so putting one action back never undoes a newer one. */
export const BotOfferAnswerUpdateSchema = lazyZodSchema(() =>
  BotOfferAnswerSchema.extend({
    claim: z.literal(true).optional(),
    release: z.enum(BOT_OFFER_ANSWER_FIELDS).optional(),
    ifRevision: z.number().int().min(0).max(1_000_000).optional()
  })
)

export type BotOfferAnswerUpdate = z.infer<typeof BotOfferAnswerUpdateSchema>

/** A claim lost to another window, device or press: that one sends, this one doesn't. */
export const BOT_OFFER_ALREADY_ANSWERED = 'bot_offer_already_answered'

/** `update` merged into the card's own entry. Never trimmed: a card whose answer went would open again.
 *  Throws BOT_OFFER_ALREADY_ANSWERED, saving nothing, when a claim comes after the card was answered. */
export function withBotOfferAnswer(
  answers: readonly BotOfferAnswer[] | undefined,
  { claim, release, ifRevision, ...answer }: BotOfferAnswerUpdate
): BotOfferAnswer[] {
  const previous = answers?.find((entry) => entry.cardId === answer.cardId)
  if (ifRevision !== undefined && (previous?.revision ?? 0) !== ifRevision) {
    return [...(answers ?? [])]
  }
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

/** The idempotency key of one card answer: the card, the kind of answer and the card's revision. Every
 *  press, window and device answering that card that way sends the same one, whatever it chose; a
 *  further action (`answerBotOfferAgain`) is the next revision, so it gets its own. */
export function botOfferAnswerKey(
  cardId: string,
  field: BotOfferAnswerField,
  revision = 0
): string {
  return `${cardId}\n${field}\n${revision}`
}

function sameChoice(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Tells the bot under `answerKey`; when the host already told it an earlier choice for that key,
 *  the card takes that choice back, so it shows what the bot heard. */
async function tellAndReconcile(
  answer: { cardId: string; sent?: BotOfferAnswer['sent'] },
  revision: number,
  answerKey: string,
  ops: {
    update: (offerAnswer: BotOfferAnswerUpdate) => Promise<unknown>
    send: (answerKey: string) => Promise<BotOfferTold>
  }
): Promise<boolean> {
  const told = await ops.send(answerKey)
  if (told.sent && answer.sent && told.chosen && !sameChoice(told.chosen, answer.sent.chosen)) {
    await ops.update({
      cardId: answer.cardId,
      sent: { chosen: [...told.chosen] },
      ifRevision: revision
    })
  }
  return told.sent
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
    /** Tells the bot, with `answerKey` for the host to drop a repeat of; `sent: false` when the chat refused it. */
    send: (answerKey: string) => Promise<BotOfferTold>
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
    sent = await tellAndReconcile(answer, 0, botOfferAnswerKey(answer.cardId, field), ops)
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
 * its own press, so it takes no claim; it replaces the card's answer as the card's next revision and
 * tells the bot under that revision's key. A refused or failed send puts the previous answer back,
 * unless a newer action replaced it meanwhile.
 */
export async function answerBotOfferAgain(
  answer: { cardId: string; sent: NonNullable<BotOfferAnswer['sent']> },
  previous: Pick<BotOfferAnswer, 'sent' | 'revision'> | undefined,
  ops: {
    update: (offerAnswer: BotOfferAnswerUpdate) => Promise<unknown>
    send: (answerKey: string) => Promise<BotOfferTold>
  }
): Promise<Exclude<BotOfferAnswerOutcome, 'already_answered'>> {
  const before = previous?.revision ?? 0
  const revision = before + 1
  await ops.update({ ...answer, revision })
  let sent = false
  try {
    sent = await tellAndReconcile(
      answer,
      revision,
      botOfferAnswerKey(answer.cardId, 'sent', revision),
      ops
    )
  } finally {
    if (!sent) {
      await ops.update(
        previous?.sent
          ? { cardId: answer.cardId, sent: previous.sent, revision: before, ifRevision: revision }
          : { cardId: answer.cardId, release: 'sent', revision: before, ifRevision: revision }
      )
    }
  }
  return sent ? 'sent' : 'refused'
}
