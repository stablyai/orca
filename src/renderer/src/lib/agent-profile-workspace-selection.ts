// Reject unsupported owners before an old remote host can silently discard profile fields.
import {
  captureAgentLaunchProfile,
  type AgentLaunchProfile
} from '../../../shared/agent-launch-profile'
import {
  isProfileAgent,
  profileRequiresFreshTerminal,
  supportsAgentProfileHost
} from '../../../shared/agent-profile-capabilities'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { useAppStore } from '@/store'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { getConnectionIdFromState } from './connection-owner-resolution'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
export function assertAgentProfileWorkspace(
  store: ReturnType<typeof useAppStore.getState>,
  agent: string,
  worktreeId: string
): void {
  if (
    !isProfileAgent(agent) ||
    !isTuiAgentEnabled(agent, store.settings?.disabledTuiAgents) ||
    !isLocalAgentProfileHost() ||
    getConnectionIdFromState(store, worktreeId) !== null ||
    isPairedWebClientWindow() ||
    getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  ) {
    throw new Error('Profiles require an enabled agent on a local macOS/Linux workspace.')
  }
}
export function resolveAgentProfileForWorkspace(
  store: ReturnType<typeof useAppStore.getState>,
  args: { agent: TuiAgent; worktreeId: string; agentProfileId?: string }
): AgentLaunchProfile | undefined {
  if (args.agentProfileId === undefined) {
    return undefined
  }
  assertAgentProfileWorkspace(store, args.agent, args.worktreeId)
  const profile = captureAgentLaunchProfile(
    store.settings?.agentLaunchProfiles ?? [],
    args.agentProfileId
  )
  if (profile.agent !== args.agent || profile.hostId !== 'local') {
    throw new Error('Profile agent or execution host does not match this workspace.')
  }
  return profile
}

export function isLocalAgentProfileHost(): boolean {
  const host = typeof window !== 'undefined' ? window.api?.platform?.get?.() : undefined
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return supportsAgentProfileHost({
    platform:
      host?.platform ??
      (/Mac/i.test(userAgent) ? 'darwin' : /Linux/i.test(userAgent) ? 'linux' : 'unknown'),
    hostId: 'local',
    isWsl: /microsoft/i.test(host?.osRelease ?? '')
  })
}

export function assertStructuredAgentProfileWorkspace(
  store: ReturnType<typeof useAppStore.getState>,
  agent: string,
  worktreeId: string,
  profile?: AgentLaunchProfile,
  executionHostId: ExecutionHostId = 'local'
): void {
  if (!profile) {
    return
  }
  assertAgentProfileWorkspace(store, agent, worktreeId)
  if (
    executionHostId !== 'local' ||
    profile.agent !== agent ||
    profile.hostId !== 'local' ||
    profileRequiresFreshTerminal(profile.binding)
  ) {
    throw new Error('This profile requires a fresh local terminal.')
  }
}
