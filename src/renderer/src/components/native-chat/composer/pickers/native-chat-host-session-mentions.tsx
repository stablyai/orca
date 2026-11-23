import { SquareTerminal } from 'lucide-react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import type { AgentConversationRow } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalSummary } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/agent-session/identity/orca-session-address-prefix'
import { parseRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
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

/** What one host lists when `@` opens. */
export type HostSessionLists = {
  hostKey: string
  agents: readonly AgentConversationRow[]
  terminals: readonly RuntimeTerminalSummary[]
  /** A bot's home: the bot's row names its chats. */
  isBotHome: (worktreeId: string) => boolean
}

/** The composer's own chat or terminal, which `@` leaves out. */
export type HostSessionSelf = { paneKey: string; sessionId?: string; ptyId: string | null }

/** The host's other chats and terminals as `@` rows and the chips they insert. Addresses in
 *  `listed` (the crew agents) and chats in a bot's home are left out, so no row shows twice. */
export function hostSessionMentions(
  { hostKey, agents, terminals, isBotHome }: HostSessionLists,
  self: HostSessionSelf,
  listed: ReadonlySet<string>
): HostSessionMentions {
  const references = new Map<string, OrchestrationAgentReference>()
  const chats = agents.flatMap((row): NativeChatRoomMention[] => {
    const id = row.orcaSessionId
    const key = `host-chat:${id}`
    const address = `${ORCA_SESSION_ADDRESS_PREFIX}${id}`
    if (
      row.kind !== 'chat' ||
      !id ||
      references.has(key) ||
      listed.has(address) ||
      isBotHome(row.worktreeId) ||
      // The pane key names the running session, which differs from the ID after a /clear.
      row.paneKey === self.paneKey ||
      id === self.sessionId
    ) {
      return []
    }
    const label = row.title || row.agent || id
    const agentType = row.agent ?? undefined
    references.set(key, { label, address, hostKey, kind: 'chat', agentType })
    return [
      {
        key,
        name: label,
        icon: <AgentTypeIcon agentType={agentType} size={14} className="mt-0.5 size-3.5" />,
        note: row.workspace
      }
    ]
  })
  // A remote pane's PTY id wraps the host's terminal handle.
  const ownPty = self.ptyId && (parseRemoteRuntimePtyId(self.ptyId)?.handle ?? self.ptyId)
  const shells = terminals.flatMap((terminal): NativeChatRoomMention[] => {
    if (
      terminal.orphaned ||
      listed.has(terminal.handle) ||
      (ownPty && (terminal.ptyId === ownPty || terminal.handle === ownPty))
    ) {
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
