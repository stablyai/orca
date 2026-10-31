import type { AgentMessageSender, AgentMessageSource } from './agent-session-message-source'
import type { AgentStatusEntry } from '../agent-status-types'

export const AGENT_MESSAGE_FOLDED_LINES = 3
export type AgentMessageHeading = 'started' | 'task' | 'coordinator' | 'worker' | 'generic'
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

export function agentMessageHeading(
  from: AgentMessageSource,
  agentStart = false
): AgentMessageHeading {
  if (agentStart) {
    return 'started'
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

export function agentMessageOverflows(height: number, lineHeight: number): boolean {
  return height > lineHeight * AGENT_MESSAGE_FOLDED_LINES + 1
}

export function agentMessageFoldLabel(open: boolean): 'expanded' | 'collapsed' {
  return open ? 'expanded' : 'collapsed'
}

export function agentMessageCanCopy(text: string): boolean {
  return text.length > 0
}
