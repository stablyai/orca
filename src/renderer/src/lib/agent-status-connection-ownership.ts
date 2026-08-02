import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

export type AgentStatusConnectionRouting = { connectionId: string | null }

type AgentStatusRoutingState = {
  terminalLayoutsByTabId:
    | Record<string, { ptyIdsByLeafId?: Record<string, string | undefined> } | undefined>
    | undefined
  ptyIdsByTabId: Record<string, string[] | undefined> | undefined
  sshConnectionStates: ReadonlyMap<string, { status: string }>
  transientClearedAgentStatusConnectionIds: Record<string, true>
}

export function resolveAgentStatusConnectionRouting(args: {
  ptyId: string | null | undefined
  expectedConnectionId?: string | null
  runtimeEnvironmentId?: string | null
}): AgentStatusConnectionRouting | undefined {
  const ptyId = args.ptyId?.trim()
  if (!ptyId) {
    return undefined
  }
  const expectedConnectionId = args.expectedConnectionId?.trim() || args.expectedConnectionId
  const sshPty = parseAppSshPtyId(ptyId)
  if (sshPty) {
    if (
      typeof args.runtimeEnvironmentId === 'string' ||
      expectedConnectionId === null ||
      (typeof expectedConnectionId === 'string' && expectedConnectionId !== sshPty.connectionId)
    ) {
      return undefined
    }
    return { connectionId: sshPty.connectionId }
  }
  if (ptyId.startsWith('ssh:')) {
    return undefined
  }

  const runtimePty = parseRemoteRuntimePtyId(ptyId)
  if (runtimePty?.handle) {
    if (
      typeof expectedConnectionId === 'string' ||
      args.runtimeEnvironmentId === null ||
      (typeof args.runtimeEnvironmentId === 'string' &&
        runtimePty.environmentId !== null &&
        runtimePty.environmentId !== args.runtimeEnvironmentId)
    ) {
      return undefined
    }
    return { connectionId: null }
  }
  if (ptyId.startsWith('remote:')) {
    return undefined
  }

  // Why: app-wide SSH and remote-runtime PTY IDs are namespaced; a remaining
  // concrete PTY is authoritative local/WSL ownership, never an SSH guess.
  if (typeof expectedConnectionId === 'string') {
    return undefined
  }
  return { connectionId: null }
}

export function resolveLiveAgentStatusConnectionRouting(args: {
  state: AgentStatusRoutingState
  paneKey: string
  ptyId: string
  expectedConnectionId?: string | null
  runtimeEnvironmentId?: string | null
}): AgentStatusConnectionRouting | undefined {
  const pane = parsePaneKey(args.paneKey)
  if (
    !pane ||
    !args.state.ptyIdsByTabId?.[pane.tabId]?.includes(args.ptyId) ||
    args.state.terminalLayoutsByTabId?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] !== args.ptyId
  ) {
    return undefined
  }
  const routing = resolveAgentStatusConnectionRouting(args)
  if (!routing) {
    return undefined
  }
  // Why: transient relay reconnect clears statuses without dropping durable
  // PTY bindings; old renderer callbacks must stay blocked until reconnect.
  if (
    routing.connectionId !== null &&
    (args.state.sshConnectionStates.get(routing.connectionId)?.status !== 'connected' ||
      routing.connectionId in args.state.transientClearedAgentStatusConnectionIds)
  ) {
    return undefined
  }
  return routing
}
