import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../agent-session/lifecycle/agent-session-resume'
import { sameAgentStatusTerminalOwner } from '../../agent-status/identity/agent-status-terminal-owner'

export type NativeChatSessionOptionBinding = {
  agent: string
  connectionId?: string | null
  worktreeId?: string
  terminalHandle?: string | null
  ptyId?: string | null
  incarnationId?: string | null
  providerSession?: AgentProviderSessionMetadata
}

/** Missing legacy metadata can enrich an owner, but cannot erase known identity. */
export function sameNativeChatSessionOptionBinding(
  left: NativeChatSessionOptionBinding,
  right: NativeChatSessionOptionBinding
): boolean {
  if (
    left.agent !== right.agent ||
    !sameAgentStatusTerminalOwner(
      {
        ...left,
        connectionId: left.connectionId === undefined ? right.connectionId : left.connectionId
      },
      {
        ...right,
        connectionId: right.connectionId === undefined ? left.connectionId : right.connectionId
      }
    )
  ) {
    return false
  }
  for (const key of ['terminalHandle', 'ptyId', 'incarnationId'] as const) {
    if (left[key] && right[key] && left[key] !== right[key]) {
      return false
    }
  }
  return (
    !left.providerSession ||
    !right.providerSession ||
    agentProviderSessionsEqual(left.agent, left.providerSession, right.providerSession)
  )
}

export function enrichNativeChatSessionOptionBinding(
  previous: NativeChatSessionOptionBinding,
  current: NativeChatSessionOptionBinding
): NativeChatSessionOptionBinding {
  return {
    ...previous,
    ...current,
    connectionId: current.connectionId === undefined ? previous.connectionId : current.connectionId,
    worktreeId: current.worktreeId ?? previous.worktreeId,
    terminalHandle: current.terminalHandle ?? previous.terminalHandle,
    ptyId: current.ptyId ?? previous.ptyId,
    incarnationId: current.incarnationId ?? previous.incarnationId,
    providerSession: current.providerSession ?? previous.providerSession
  }
}
