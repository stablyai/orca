import * as z from 'zod'
import {
  LOOK_AROUND_EVERY_CHOICES,
  LOOK_AROUND_FOCUS_MAX_LENGTH,
  SUGGESTION_LIMITS
} from '../bots/bot-look-around'
import { OFFER_SOURCES } from '../bots/bot-connector-offer'
import { OptionalString, requiredString } from './rpc-param-primitives'

const text = (max: number, missing: string) => z.string().trim().min(1, missing).max(max)

/** `orca bot suggest`, from a look-around run: the host knows the run by its chat. */
export const BotSuggest = z.object({
  callerSessionId: requiredString('Run this from a look-around run.'),
  title: text(SUGGESTION_LIMITS.title, 'Missing title'),
  why: text(SUGGESTION_LIMITS.why, 'Missing why'),
  ask: text(SUGGESTION_LIMITS.ask, 'Missing ask'),
  link: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), 'The link must be an http(s) URL')
    .optional()
})

/** Start or Dismiss one Up next suggestion. */
export const BotSuggestionAct = z.object({
  botId: requiredString('Missing bot id'),
  suggestionId: requiredString('Missing suggestion id')
})

/** Settings' Look now, and a new bot's onboarding: start a look without waiting for its hours. */
export const BotLookNow = z.object({ botId: requiredString('Missing bot id') })

/** The owner saw the bot's Up next: what it lists stops counting as new. */
export const BotUpNextSeen = z.object({ botId: requiredString('Missing bot id') })

/** `orca bot look-around set`: the bot changes its own Look around when its owner asks in chat. */
export const BotLookAroundSet = z.object({
  /** Absent: the bot whose chat ran the command. */
  botId: OptionalString,
  callerSessionId: OptionalString,
  on: z.boolean().optional(),
  every: z.enum(LOOK_AROUND_EVERY_CHOICES).optional(),
  weekdaysOnly: z.boolean().optional(),
  focus: z.string().trim().max(LOOK_AROUND_FOCUS_MAX_LENGTH).optional()
})

export type BotSuggestParams = z.infer<typeof BotSuggest>
export type BotLookAroundSetParams = z.infer<typeof BotLookAroundSet>

/** `orca bot connectors --offer`: the bot asks Orca to show its owner a Connect card in this chat. */
export const BotConnectorOffer = z
  .object({
    callerSessionId: requiredString('Run this from your chat.'),
    source: z.enum(OFFER_SOURCES),
    workspace: z.string().trim().min(1).max(200).optional()
  })
  .refine((offer) => offer.source !== 'google' || offer.workspace === undefined, {
    message: 'Google takes no --workspace.',
    path: ['workspace']
  })

export type BotConnectorOfferParams = z.infer<typeof BotConnectorOffer>

export const BotConnectors = z.object({
  callerSessionId: requiredString("Run this from a bot's chat.")
})

/** How a bot request on a card in the owner's chat stands. */
export const BotRequestOutcomeParams = z.object({
  messageId: requiredString('Missing messageId')
})

/** Read a bot's Tidy-up, or start one now. */
export const BotTidyUpAct = z.object({ botId: requiredString('Missing bot id') })

/** Undo the tidy-up the owner reviewed, by its History row; a newer one is never undone in its place. */
export const BotTidyUpUndo = z.object({
  botId: requiredString('Missing bot id'),
  rowId: requiredString('Missing row id')
})
