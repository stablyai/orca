import type { BotMemoryUpdatedNote } from '../../bots/bot-memory-updated-note'
import type { ConnectorOffer } from '../../bots/bot-connector-offer'
import type { BotCreateOffer } from '../../bots/bot-proposal'
import type { BotImportDone, BotImportPlan } from '../../bots/bot-import-cards'
import type { BotRequestCard } from '../../bots/bot-request-card'
import type { GoogleSetupCardRef } from '../../google/google-setup-card'
import type { ComposioSetupCardRef } from '../../composio/composio-setup-card'
import type { AgentJournalToolAddedItem } from '../../agent-journal-orca-card-items'

/** Each card a status line can carry in place of its text, by its field. */
export type NativeChatBotCardFieldValues = {
  botMemoryUpdated: BotMemoryUpdatedNote
  /** A bot's Connect card for a connector it needs; read with `connectorOfferOf`. */
  connectorOffer: ConnectorOffer
  /** A bot's plan for bringing over a bot from another app; read with `botImportPlanOf`. */
  botImportPlan: BotImportPlan
  /** What that import brought over; read with `botImportDoneOf`. */
  botImportDone: BotImportDone
  /** A bot's request to another bot, in its owner's chat; read with `botRequestCardOf`. */
  botRequest: BotRequestCard
  /** A Google setup card in a bot's chat; read with `googleSetupCardOf`. */
  googleSetup: GoogleSetupCardRef
  /** A Composio setup card in a bot's chat; read with `composioSetupCardOf`. */
  composioSetup: ComposioSetupCardRef
  /** A bot's proposal for a new bot; read with `botCreateOfferOf`. */
  botCreateOffer: BotCreateOffer
}

/** Clients read these only through `nativeChatBotCardOf`, so a new field needs a kind (and a phone
 *  decision) to show anywhere. */
export type NativeChatBotCardFields = {
  [F in keyof NativeChatBotCardFieldValues]?: NativeChatBotCardFieldValues[F]
}

/** Each card a whole message is drawn as, by its field. */
export type NativeChatBotMessageCardFieldValues = {
  /** Projected fact: this chat's bot gave itself a tool. */
  toolAdded: Omit<AgentJournalToolAddedItem, 'kind'>
}

/** Read only through `nativeChatBotMessageCardOf`, like the status-line cards. */
export type NativeChatBotMessageCardFields = {
  [F in keyof NativeChatBotMessageCardFieldValues]?: NativeChatBotMessageCardFieldValues[F]
}
