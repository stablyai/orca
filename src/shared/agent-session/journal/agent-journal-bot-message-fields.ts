import type { AutomationTriggeredBy } from '../../bots/bot-acts-for'
import type { TookOverNotice } from '../../native-chat/took-over-notice'
import type { ConnectorMessageAsker } from '../../connector-message-asker'
import type { AutomationRunMessage } from '../../automations/automation-run-message'
import type { AgentJournalWorkTarget } from '../work-target/agent-session-work-target'

/** The account whose connector handed the delivery over, its conversation and ids. */
export type AgentJournalConnectorDelivery = {
  account: string
  conversation: { source: string; externalId: string }
  deliveryId: string
  carried?: string[]
}

/** A continuation's claim on the requests a cut owed (Phase 1): the cut it continues (a turn's or a
 *  send's id) and the deliveries that cut answered, as their own stamps. Which rows it holds is
 *  what its admission committed (journal_connector_replies.claim_message_id), never this list. */
export type AgentJournalConnectorClaim = {
  cutTurnId: string
  /** Which cut it is: a restart's, or a usage limit's. */
  cutKind: 'restart' | 'usage_limit'
  origin: AgentJournalConnectorDelivery[]
}

/** What Orca writes on a message it delivers to a bot. */
export type AgentJournalBotMessageFields = {
  /** Present on a message Orca delivered to a bot from Slack, GitHub or Linear: only then does the
   *  chat read its labelled form. `bot-created` is Orca's own first turn to a new bot, drawn as a
   *  notice row. `card-answer` is an owner's click on a setup card: the card's receipt is its only
   *  visible part. `took-over` is Orca's turn handing the bot a workspace, drawn from `tookOver`.
   *  `automation-run` is a bot automation's run, drawn from `automationRun` as the automation's row.
   *  Host-written, like `from`. */
  origin?: 'connector' | 'bot-created' | 'card-answer' | 'took-over' | 'automation-run'
  /** Beside `automation-run`: the run as delivered. Host-written, never sent to the agent. */
  automationRun?: AutomationRunMessage
  /** Beside `took-over`: the workspace and the owner's goal, for the chat's divider. Host-written. */
  tookOver?: TookOverNotice
  /** Beside `origin`: who asked and where, for the chat's tag on the message. Host-written. */
  asker?: ConnectorMessageAsker
  /** The conversation whose delivery this message is, as it was when delivered; never rewritten, so
   *  a turn it opens stays that conversation's though the chat is later linked elsewhere.
   *  Host-written, never sent to the agent. */
  connectorConversation?: { source: string; externalId: string }
  /** The connector delivery this message admits, and the later ones it carries: each gets its
   *  answer or a truthful outcome through the reply outbox. Kept across a queued edit. Host-written,
   *  never sent to the agent. */
  connectorDelivery?: AgentJournalConnectorDelivery
  /** On a continuation Orca sends after a cut: the requests it answers in the cut's place.
   *  Host-written, never sent to the agent. */
  connectorClaim?: AgentJournalConnectorClaim
  /** Present on a message Orca sent for a bot's automation run: where what the bot learns in its
   *  turn came from, as its memory says it ("Webhook deploys"). Host-written, like `from`. */
  memorySource?: string
  /** Beside `memorySource`: who did the event that started the run, for the record. Host-written. */
  triggeredBy?: AutomationTriggeredBy
  /** Optional project or existing workspace selected in a bot chat for this single message. */
  workTarget?: AgentJournalWorkTarget
}
