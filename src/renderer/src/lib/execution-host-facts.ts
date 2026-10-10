import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ParsedExecutionHost
} from '../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { AppState } from '@/store/types'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import { CLIENT_PLATFORM } from './new-workspace'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'

/**
 * The OS of the machine an agent runs on. `withheld` means no host has reported it; a launch must
 * stop there, because the client's or the endpoint's OS would quote the command for the wrong shell.
 */
export type ExecutionHostPlatformFact =
  | { kind: 'known'; platform: NodeJS.Platform; hostKind: ParsedExecutionHost['kind'] }
  | { kind: 'withheld'; reason: string }

type HostFactsState = Pick<
  AppState,
  'sshConnectionStates' | 'sshStateByEnvironment' | 'runtimeStatusByEnvironmentId'
>

type WorktreeHostFactsState = HostFactsState &
  Pick<
    AppState,
    | 'activeRepoId'
    | 'activeWorktreeId'
    | 'detectedWorktreesByRepo'
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'projects'
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
  >

const SSH_PLATFORM_WITHHELD =
  'The SSH host has not reported its operating system yet. Connect to it and try again.'
const RUNTIME_PLATFORM_WITHHELD =
  'The Orca server has not reported its operating system yet. Reconnect to it and try again.'
const RUNTIME_PLATFORM_UPDATE =
  'This Orca server does not report its operating system. Update the server to launch agents on it.'
const HOST_UNRESOLVED_WITHHELD = 'Orca cannot tell which host owns this workspace yet.'

function resolveLocalPlatform(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  workspacePath: string | null | undefined
): NodeJS.Platform {
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved') {
    return projectRuntime.runtime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  return workspacePath && isWslUncPath(workspacePath) ? 'linux' : CLIENT_PLATFORM
}

function resolveHostPlatform(
  state: HostFactsState,
  args: {
    host: ParsedExecutionHost | null
    /** SSH target reached through a runtime host (`runtime:E` + target T). */
    nestedSshTargetId: string | null
    /** Runtime host owning an `ssh:T` workspace, when it is nested rather than direct. */
    sshOwnerEnvironmentId: string | null
    workspacePath: string | null | undefined
    projectRuntime: () => ProjectExecutionRuntimeResolution | undefined
  }
): ExecutionHostPlatformFact {
  const { host } = args
  if (!host) {
    return { kind: 'withheld', reason: HOST_UNRESOLVED_WITHHELD }
  }
  if (host.kind === 'local') {
    const platform = resolveLocalPlatform(args.projectRuntime(), args.workspacePath)
    return { kind: 'known', platform, hostKind: 'local' }
  }
  const sshTargetId = host.kind === 'ssh' ? host.targetId : args.nestedSshTargetId
  if (sshTargetId) {
    const ownerEnvironmentId =
      host.kind === 'runtime' ? host.environmentId : args.sshOwnerEnvironmentId
    const sshState = ownerEnvironmentId
      ? state.sshStateByEnvironment.get(ownerEnvironmentId)?.connectionStates.get(sshTargetId)
      : state.sshConnectionStates.get(sshTargetId)
    return sshState?.remotePlatform
      ? { kind: 'known', platform: sshState.remotePlatform, hostKind: 'ssh' }
      : { kind: 'withheld', reason: SSH_PLATFORM_WITHHELD }
  }
  if (host.kind !== 'runtime') {
    return { kind: 'withheld', reason: HOST_UNRESOLVED_WITHHELD }
  }
  const status = lastVerifiedRuntimeStatus(
    state.runtimeStatusByEnvironmentId.get(host.environmentId)
  )
  const hostPlatform = status?.hostPlatform
  if (!hostPlatform) {
    const reason = status ? RUNTIME_PLATFORM_UPDATE : RUNTIME_PLATFORM_WITHHELD
    return { kind: 'withheld', reason }
  }
  // Why: a WSL UNC workspace on a Windows server runs its agents inside that distro.
  const platform =
    hostPlatform === 'win32' && args.workspacePath && isWslUncPath(args.workspacePath)
      ? 'linux'
      : hostPlatform
  return { kind: 'known', platform, hostKind: 'runtime' }
}

/** Platform of the host that runs agents for a repo that has no workspace yet. */
export function resolveRepoExecutionHostPlatform(
  state: HostFactsState,
  repo: { connectionId?: string | null; executionHostId?: string | null; path: string },
  projectRuntime: () => ProjectExecutionRuntimeResolution | undefined
): ExecutionHostPlatformFact {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return resolveHostPlatform(state, {
    host,
    nestedSshTargetId: host?.kind === 'runtime' ? repo.connectionId?.trim() || null : null,
    sshOwnerEnvironmentId: null,
    workspacePath: repo.path,
    projectRuntime
  })
}

/** Platform of the host that runs agents for a worktree or folder workspace. */
export function resolveWorktreeExecutionHostPlatform(
  state: WorktreeHostFactsState,
  worktreeId: string,
  workspacePath: string | null | undefined
): ExecutionHostPlatformFact {
  // Why the routing default: an owner-less row launches where routing sends it, so read that host.
  const host = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))
  return resolveHostPlatform(state, {
    host,
    nestedSshTargetId:
      host?.kind === 'runtime' ? (getConnectionIdFromState(state, worktreeId) ?? null) : null,
    sshOwnerEnvironmentId:
      host?.kind === 'ssh' ? getRuntimeEnvironmentIdForWorktree(state, worktreeId) : null,
    workspacePath,
    projectRuntime: () => getLocalProjectExecutionRuntimeContext(state, worktreeId)
  })
}

export function requireExecutionHostPlatform(fact: ExecutionHostPlatformFact): NodeJS.Platform {
  if (fact.kind === 'withheld') {
    throw new Error(fact.reason)
  }
  return fact.platform
}

/** `terminalWindowsShell` describes this client's shell, so it only shapes local launches. */
export function resolveExecutionHostAgentStartupShell(
  fact: ExecutionHostPlatformFact,
  terminalWindowsShell: string | null | undefined
): AgentStartupShell | undefined {
  return fact.kind === 'known'
    ? resolveLocalWindowsAgentStartupShell({
        platform: fact.platform,
        isRemote: fact.hostKind !== 'local',
        terminalWindowsShell
      })
    : undefined
}
