import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
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

type LivePanePtyBindingState = Pick<
  AgentStatusRoutingState,
  'terminalLayoutsByTabId' | 'ptyIdsByTabId'
>

function resolveLivePanePtyId(state: LivePanePtyBindingState, paneKey: string): string | null {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return null
  }
  const ptyId = state.terminalLayoutsByTabId?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  return ptyId && state.ptyIdsByTabId?.[pane.tabId]?.includes(ptyId) ? ptyId : null
}

export function resolveLiveAgentStatusExecutionHostId(
  state: LivePanePtyBindingState,
  paneKey: string
): ExecutionHostId | null {
  const ptyId = resolveLivePanePtyId(state, paneKey)
  if (!ptyId) {
    return null
  }
  const sshPty = parseAppSshPtyId(ptyId)
  if (sshPty) {
    return toSshExecutionHostId(sshPty.connectionId)
  }
  if (ptyId.startsWith('ssh:')) {
    return null
  }
  const runtimePty = parseRemoteRuntimePtyId(ptyId)
  if (runtimePty) {
    return runtimePty.handle && runtimePty.environmentId
      ? toRuntimeExecutionHostId(runtimePty.environmentId)
      : null
  }
  return ptyId.startsWith('remote:') ? null : 'local'
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
  if (resolveLivePanePtyId(args.state, args.paneKey) !== args.ptyId) {
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
