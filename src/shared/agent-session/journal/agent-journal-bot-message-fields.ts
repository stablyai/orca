import type { AutomationTriggeredBy } from '../../bots/bot-acts-for'
import type { TookOverNotice } from '../../native-chat/took-over-notice'
import type { ConnectorMessageAsker } from '../../connector-message-asker'
import type { AutomationRunMessage } from '../../automations/automation-run-message'

/** The account whose connector handed the delivery over, its conversation and ids. */
export type AgentJournalConnectorDelivery = {
  account: string
  conversation: { source: string; externalId: string }
  deliveryId: string
  carried?: string[]
}

/** The interrupted work a restart continuation resumes: a turn by its lifecycle turn id or its row's
 *  item key, or a send that had not become a turn by its client message id. */
export type AgentJournalRestartOf = {
  kind: 'turn' | 'turn-item' | 'submission'
  id: string
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
  /** On a restart continuation: the work it resumes, so the requests that work answered are answered
   *  by the continuation instead (design: slack-reply-lost-restart). Host-written, never sent to the
   *  agent; a client's send can't carry it (SendBody is strict). */
  restartOf?: AgentJournalRestartOf
  /** Present on a message Orca sent for a bot's automation run: where what the bot learns in its
   *  turn came from, as its memory says it ("Webhook deploys"). Host-written, like `from`. */
  memorySource?: string
  /** Beside `memorySource`: who did the event that started the run, for the record. Host-written. */
  triggeredBy?: AutomationTriggeredBy
}
