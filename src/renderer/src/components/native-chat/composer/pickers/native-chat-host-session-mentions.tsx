import { SquareTerminal } from 'lucide-react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import type { AgentConversationRow } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalSummary } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/agent-session/identity/orca-session-address-prefix'
import type { OrchestrationAgentReference } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import type { NativeChatRoomMention } from '../native-chat-composer-types'

export type HostSessionMentions = {
  chats: readonly NativeChatRoomMention[]
  terminals: readonly NativeChatRoomMention[]
  references: ReadonlyMap<string, OrchestrationAgentReference>
}

export const NO_HOST_SESSION_MENTIONS: HostSessionMentions = Object.freeze({
  chats: [],
  terminals: [],
  references: new Map()
})

/** The composer's own chat or terminal, which `@` leaves out. */
export type HostSessionSelf = { sessionId?: string; ptyId?: string | null }

/** The other chats and terminals of one host, as `@` rows and the chips they insert. */
export function hostSessionMentions(
  agents: readonly AgentConversationRow[],
  terminals: readonly RuntimeTerminalSummary[],
  hostKey: string,
  self: HostSessionSelf
): HostSessionMentions {
  const references = new Map<string, OrchestrationAgentReference>()
  const selfPane = self.sessionId
    ? structuredAgentSessionPaneKey(structuredAgentSessionTabId(self.sessionId), self.sessionId)
    : null
  const chats = agents.flatMap((row): NativeChatRoomMention[] => {
    const id = row.orcaSessionId
    // The pane key names the running session, which differs from the ID after a /clear.
    if (row.kind !== 'chat' || !id || id === self.sessionId || row.paneKey === selfPane) {
      return []
    }
    const key = `host-chat:${id}`
    const label = row.title || row.agent || id
    const agentType = row.agent ?? undefined
    references.set(key, {
      label,
      address: `${ORCA_SESSION_ADDRESS_PREFIX}${id}`,
      hostKey,
      kind: 'chat',
      agentType
    })
    return [
      {
        key,
        name: label,
        icon: <AgentTypeIcon agentType={agentType} size={14} className="mt-0.5 size-3.5" />,
        note: row.workspace
      }
    ]
  })
  const shells = terminals.flatMap((terminal): NativeChatRoomMention[] => {
    if (terminal.orphaned || (self.ptyId && terminal.ptyId === self.ptyId)) {
      return []
    }
    const key = `host-terminal:${terminal.handle}`
    const label = terminal.paneTitle || terminal.title || terminal.handle
    references.set(key, { label, address: terminal.handle, hostKey, kind: 'terminal' })
    return [
      {
        key,
        name: label,
        icon: <SquareTerminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />,
        note: terminal.branch || undefined
      }
    ]
  })
  return { chats, terminals: shells, references }
}
