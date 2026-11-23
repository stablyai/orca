import type { BotAgentSetup } from './bots/bot-agent-setup'
import type {
  AgentJournalAgentHandoffItem,
  AgentJournalAgentStartItem as PublicAgentStartItem
} from './agent-session/journal/agent-journal-creation-facts'
import type { AgentType } from './agent-status/contracts/agent-status-types'
import type { AutomationBotResultsTo } from './automation-bot-target'
import type { BotAutomationFacts } from './bots/bot-automation-rows'
import type { BotOwnTool } from './bot-tools'
import type { WaitEnding } from './automation-once'
import type { AutomationRunMessage } from './automations/automation-run-message'
import type { BotRequestAsker } from './bots/bot-acts-for'
import type { AgentSessionRefusalReference } from './agent-session/failures/agent-session-wire-refusals'
import type { AgentJournalBotItemNoteItem } from './bots/bot-item-note'

export type { AgentJournalAgentHandoffItem, AgentJournalBotItemNoteItem }

/** Display-only creation fact; survives removal of the orchestration Task and Dispatch. */
export type AgentJournalAgentStartItem = PublicAgentStartItem & {
  /** Read only from earlier bot builds; the worker sender now carries its agent. */
  agent?: AgentType
}

/** Display-only: this chat's agent created or edited an automation; what it saved, never its prompt. */
export type AgentJournalAutomationSavedItem = {
  kind: 'automation-saved'
  change: 'created' | 'updated'
  automation: BotAutomationFacts
  /** A bot automation's destination; absent for a project automation, whose results stay in its runs. */
  resultsTo?: AutomationBotResultsTo
  /** A bot automation's own agent for its runs; absent on the bot's. */
  agentSetup?: BotAgentSetup
}

/** Display-only: this chat's bot gave itself a tool; the card offers its sign-in and removing it. */
export type AgentJournalToolAddedItem = {
  kind: 'tool-added'
  botId: string
  /** As added; its sign-in is read live, so none is stored. */
  tool: Omit<BotOwnTool, 'signIn'>
  addedAt: number
}

/** Display-only: a wait's one run started, or it expired unrun; the wait itself is gone after. */
export type AgentJournalWaitEndedItem = {
  kind: 'wait-ended'
  automation: BotAutomationFacts
  ending: WaitEnding
}

/** Display-only: a bot automation run whose send failed, so no message took it. Kept in the chat it
 *  was meant for (else the bot's Chat) with what was going to be sent, for Send again. */
export type AgentJournalAutomationRunNotStartedItem = {
  kind: 'automation-run-not-started'
  run: AutomationRunMessage
  /** Whom the run acted for (its automation's creator), so Send again never acts for anyone else. */
  actsFor: BotRequestAsker[]
  /** The send's own error, verbatim. */
  error: string
  /** Why its chat was refused, so each reader words it from its side; older readers show `error`. */
  refusal?: AgentSessionRefusalReference
  text: string
  at: number
}

/** The card as a chat draws it: `sentAgain` once a later message in that chat carries its run. */
export type AutomationRunNotStartedRow = Omit<AgentJournalAutomationRunNotStartedItem, 'kind'> & {
  sentAgain?: true
}

/** Display-only: a bot switched to a backup model on a usage limit or returned to its primary. */
export type AgentJournalBotBackupModelSwitchItem = {
  kind: 'bot-backup-model-switch'
  switchId: string
  botId: string
  direction: 'to-backup' | 'to-primary'
  fromAgent: string
  fromModel?: string
  toAgent: string
  toModel?: string
  /** Cross-agent handoff peer session id so the user can jump between old and new conversations. */
  linkedSessionId?: string
  resetsAt?: number
  at: number
}

/** A card Orca writes into a chat's transcript when the chat's agent does something through Orca. */
export type AgentJournalOrcaCardItem =
  | AgentJournalAgentStartItem
  | AgentJournalAgentHandoffItem
  | AgentJournalAutomationSavedItem
  | AgentJournalToolAddedItem
  | AgentJournalWaitEndedItem
  | AgentJournalAutomationRunNotStartedItem
  | AgentJournalBotItemNoteItem
  | AgentJournalBotBackupModelSwitchItem
