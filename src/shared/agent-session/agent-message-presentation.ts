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

export function agentMessageSenderCanOpen(
  sender: AgentMessageSender,
  hasWorkspace: boolean
): boolean {
  return hasWorkspace && !sender.party.address.startsWith('dispatch:')
}

export function agentMessagePrimarySender(
  from: AgentMessageSource
): AgentMessageSender | undefined {
  return from.senders[0]
}

export function agentMessageSenderView(
  row: AgentMessageSenderView | undefined,
  chatType: AgentMessageSenderView['agentType']
): AgentMessageSenderView {
  return row ?? { agentType: chatType }
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
