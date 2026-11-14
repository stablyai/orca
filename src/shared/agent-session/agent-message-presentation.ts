import type { AgentMessageSender, AgentMessageSource } from './agent-session-message-source'
import type { AgentStatusEntry } from '../agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { agentMessageTranscriptText } from './agent-message-display-text'

export function agentMessageIsCompact(
  message: Pick<NativeChatMessage, 'agentStart' | 'from'>
): boolean {
  return message.agentStart === true || message.from?.kind === 'agent'
}

export type AgentMessageHeading =
  | 'started'
  | 'reopened-worker'
  | 'followed-up-worker'
  | 'handed-off'
  | 'started-agent'
  | 'task'
  | 'coordinator'
  | 'worker'
  | 'generic'
export type AgentMessageSenderView = Readonly<{
  agentType?: AgentStatusEntry['agentType']
  progress?: number
  dot?:
    | 'working'
    | 'monitoring'
    | 'blocked'
    | 'waiting'
    | 'interrupted'
    | 'failed'
    | 'done'
    | 'idle'
    | 'unverifiable'
    | 'unconfirmed'
    | 'permission'
}>

/** Takes the message's creation flags and text together, and requires them, so no caller can show a
 *  creation card as a plain message, a handoff as a started worker, or a handoff with no task as work handed over. */
export function agentMessageHeading(
  from: AgentMessageSource,
  creation: Pick<NativeChatMessage, 'agentStart' | 'agentHandoff' | 'agentFollowUp' | 'blocks'>
): AgentMessageHeading {
  if (creation.agentStart) {
    if (!creation.agentHandoff) {
      if (creation.agentFollowUp) {
        return creation.agentFollowUp === 'reopened' ? 'reopened-worker' : 'followed-up-worker'
      }
      return 'started'
    }
    return agentMessageTranscriptText(creation.blocks, from) ? 'handed-off' : 'started-agent'
  }
  if (from.orchestration?.message === 'task') {
    return 'task'
  }
  if (from.orchestration?.message === 'mail-notice' && from.senders.length > 0) {
    if (from.senders.every((sender) => sender.relation === 'coordinator')) {
      return 'coordinator'
    }
    if (from.senders.every((sender) => sender.relation === 'worker')) {
      return 'worker'
    }
  }
  return 'generic'
}

export function agentMessageSenderLabel(facts: {
  localChat: boolean
  customLabel?: string | null
  conversationName?: string | null
  snapshotName?: string | null
  tabLabel?: string | null
  fallback: string
}): string {
  return (
    (facts.localChat && (facts.customLabel?.trim() || facts.conversationName)) ||
    facts.snapshotName ||
    facts.tabLabel?.trim() ||
    facts.fallback
  )
}

/** The kind the card saved, when it names one; a saved "unknown" proves nothing, so it is none. */
export function agentMessageSavedKind(
  sender: Pick<AgentMessageSender, 'agent'> | undefined
): AgentMessageSender['agent'] {
  return sender?.agent === 'unknown' ? undefined : sender?.agent
}

/** A Dispatch address names work, not a pane; every other sender address can be opened. */
export function agentMessageSenderCanOpen(sender: AgentMessageSender): boolean {
  return (
    !sender.party.address.startsWith('dispatch:') &&
    !(
      sender.party.address.startsWith('run:') &&
      !sender.party.orcaSessionId &&
      !sender.party.terminalHandle
    )
  )
}

export function agentMessagePrimarySender(
  from: AgentMessageSource
): AgentMessageSender | undefined {
  return from.senders[0]
}

/** The sender's own kind is its icon; a live row adds only its status. */
export function agentMessageSenderView(
  row: AgentMessageSenderView | undefined,
  senderType: AgentMessageSenderView['agentType']
): AgentMessageSenderView {
  if (!row) {
    return { agentType: senderType }
  }
  return senderType === undefined || row.agentType === senderType
    ? row
    : { ...row, agentType: senderType }
}

export function agentMessageCanCopy(text: string): boolean {
  return text.length > 0
}
