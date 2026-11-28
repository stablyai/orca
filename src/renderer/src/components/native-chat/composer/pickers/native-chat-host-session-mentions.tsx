import { SquareTerminal } from 'lucide-react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import type { AgentConversationRow } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalSummary } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/agent-session/identity/orca-session-address-prefix'
import { parseRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
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

// A chat's pane key names its running session, which differs from its listed ID after a /clear.
function runs(paneKey: string, sessionId: string): boolean {
  return (
    structuredAgentSessionPaneKey(paneKey.slice(0, paneKey.lastIndexOf(':')), sessionId) === paneKey
  )
}

/** The host's other chats and terminals as `@` rows and the chips they insert. Addresses in
 *  `listed` (the crew agents) and chats in a bot's home are left out, so no row shows twice. */
export function hostSessionMentions(
  { hostKey, agents, terminals, isBotHome }: HostSessionLists,
  self: HostSessionSelf,
  listed: ReadonlySet<string>
): HostSessionMentions {
  const references = new Map<string, OrchestrationAgentReference>()
  // Every pane of the composer's own chat, and every crew chat, by listed ID and by running session.
  const hidden = new Set(
    [...listed].flatMap((address) =>
      address.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
        ? [address.slice(ORCA_SESSION_ADDRESS_PREFIX.length)]
        : []
    )
  )
  if (self.sessionId) {
    hidden.add(self.sessionId)
  }
  const running = [...hidden]
  // A pane that runs a hidden session hides its chat's listed ID, so every other pane of it goes too.
  for (const row of agents) {
    if (
      row.orcaSessionId &&
      (row.paneKey === self.paneKey || running.some((sessionId) => runs(row.paneKey, sessionId)))
    ) {
      hidden.add(row.orcaSessionId)
    }
  }
  const chats = agents.flatMap((row): NativeChatRoomMention[] => {
    const id = row.orcaSessionId
    const key = `host-chat:${id}`
    const address = `${ORCA_SESSION_ADDRESS_PREFIX}${id}`
    if (
      row.kind !== 'chat' ||
      !id ||
      references.has(key) ||
      hidden.has(id) ||
      isBotHome(row.worktreeId)
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
  // A terminal agent's pane key is its terminal's tab and leaf.
  const terminalAgents = new Map(
    agents.flatMap((row) =>
      row.kind === 'terminal' && row.orcaSessionId ? [[row.paneKey, row.orcaSessionId]] : []
    )
  )
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
    const session = terminalAgents.get(`${terminal.tabId}:${terminal.leafId}`)
    references.set(key, {
      label,
      address: terminal.handle,
      hostKey,
      kind: 'terminal',
      ...(session ? { session: `${ORCA_SESSION_ADDRESS_PREFIX}${session}` } : {})
    })
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
