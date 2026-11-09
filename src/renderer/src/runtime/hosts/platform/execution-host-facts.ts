import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ParsedExecutionHost,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../../../shared/execution-host/project-execution-runtime'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { runtimeHostContactForEntry } from '../../../../../shared/remote-runtime/host-status/runtime-host-contact'
import type { AgentStartupShell } from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveHostAgentStartupShell } from '../../../../../shared/windows-terminal-shell'
import { isWslUncPath } from '../../../../../shared/wsl-paths'
import type { AppState } from '@/store/types'
import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState
} from '../../../lib/workspace/ownership/connection-owner-resolution'
import { getLocalProjectExecutionRuntimeContext } from '../../../lib/local-preflight-context'
import { CLIENT_PLATFORM } from '../../../lib/new-workspace'
import {
  getExecutionHostIdForWorktree,
  getResourceExecutionHostIdForWorktree,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from '../../../lib/workspace/ownership/worktree-runtime-owner'

import type { ExecutionHostPlatformFact } from './execution-host-platform-fact'

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

/** A paired server still being reached may yet report the facts a launch needs. */
function runtimeContactPending(state: HostFactsState, environmentId: string | null): boolean {
  const contact = environmentId
    ? runtimeHostContactForEntry(state.runtimeStatusByEnvironmentId.get(environmentId))
    : null
  return (
    contact?.verdict === 'unverifiable' &&
    ['checking', 'transport-connecting'].includes(contact.reason)
  )
}

/** The host a terminal launch runs on, resolved from ownership alone; live facts are read separately. */
export type ExecutionHostTarget = {
  host: ParsedExecutionHost | null
  /** SSH target reached through a runtime host (`runtime:E` + target T). */
  nestedSshTargetId: string | null
  /** Runtime host owning an `ssh:T` workspace, when it is nested rather than direct. */
  sshOwnerEnvironmentId: string | null
}

function resolveHostPlatform(
  state: HostFactsState,
  args: ExecutionHostTarget & {
    workspacePath: string | null | undefined
    projectRuntime: () => ProjectExecutionRuntimeResolution | undefined
  }
): ExecutionHostPlatformFact {
  if (args.host?.kind === 'local') {
    const platform = resolveLocalPlatform(args.projectRuntime(), args.workspacePath)
    return { kind: 'known', platform, hostKind: 'local' }
  }
  return resolveRemoteHostPlatform(state, args, args.workspacePath)
}

/**
 * Whether a terminal on this host waits only because its OS has not been reported yet while it is
 * still connecting or setting up. A local host always knows its OS, so it reads nothing.
 */
export function executionHostTerminalPending(
  state: HostFactsState,
  target: ExecutionHostTarget
): boolean {
  if (!target.host || target.host.kind === 'local') {
    return false
  }
  const fact = resolveRemoteHostPlatform(state, target, undefined)
  return fact.kind === 'withheld' && fact.pending === true
}

/** A remote host's OS, from that host's own connection and contact facts only. */
function resolveRemoteHostPlatform(
  state: HostFactsState,
  args: ExecutionHostTarget,
  workspacePath: string | null | undefined
): ExecutionHostPlatformFact {
  const { host } = args
  if (!host) {
    return { kind: 'withheld', reason: HOST_UNRESOLVED_WITHHELD, recovery: 'refreshProjects' }
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
      : {
          kind: 'withheld',
          reason: SSH_PLATFORM_WITHHELD,
          recovery: sshState?.status === 'connected' ? 'sshUnavailable' : 'connectSsh',
          pending:
            ['connecting', 'reconnecting', 'deploying-relay'].includes(sshState?.status ?? '') ||
            sshState?.managedServer?.kind === 'setting-up' ||
            runtimeContactPending(state, ownerEnvironmentId)
        }
  }
  if (host.kind !== 'runtime') {
    return { kind: 'withheld', reason: HOST_UNRESOLVED_WITHHELD, recovery: 'refreshProjects' }
  }
  const status = lastVerifiedRuntimeStatus(
    state.runtimeStatusByEnvironmentId.get(host.environmentId)
  )
  const hostPlatform = status?.hostPlatform
  if (!hostPlatform) {
    const reason = status ? RUNTIME_PLATFORM_UPDATE : RUNTIME_PLATFORM_WITHHELD
    return {
      kind: 'withheld',
      reason,
      recovery: status ? 'updateServer' : 'reconnectServer',
      pending: runtimeContactPending(state, host.environmentId)
    }
  }
  // Why: a WSL UNC workspace on a Windows server runs its agents inside that distro.
  const platform =
    hostPlatform === 'win32' && workspacePath && isWslUncPath(workspacePath)
      ? 'linux'
      : hostPlatform
  return {
    kind: 'known',
    platform,
    hostKind: 'runtime',
    ...(status?.terminalWindowsShell ? { terminalWindowsShell: status.terminalWindowsShell } : {})
  }
}

/** Read the repo owner’s execution platform; workspacePath refines it for host-local namespaces such as WSL, defaulting to repo path. */
export function resolveRepoExecutionHostPlatform(
  state: HostFactsState,
  repo: { connectionId?: string | null; executionHostId?: string | null; path: string },
  projectRuntime: () => ProjectExecutionRuntimeResolution | undefined,
  workspacePath: string | null | undefined = repo.path
): ExecutionHostPlatformFact {
  return resolveHostPlatform(state, {
    ...resolveRepoExecutionHostTarget(repo),
    workspacePath,
    projectRuntime
  })
}

export function resolveRepoExecutionHostTarget(repo: {
  connectionId?: string | null
  executionHostId?: string | null
}): ExecutionHostTarget {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return {
    host,
    nestedSshTargetId: host?.kind === 'runtime' ? repo.connectionId?.trim() || null : null,
    sshOwnerEnvironmentId: null
  }
}

export function resolveWorktreeExecutionHostPlatform(
  state: WorktreeHostFactsState,
  worktreeId: string,
  workspacePath: string | null | undefined,
  executionHostId?: ExecutionHostId
): ExecutionHostPlatformFact {
  return resolveHostPlatform(state, {
    // Why the routing default: an owner-less row launches where routing sends it, and a row-less
    // setup terminal on the focused default, so read that host.
    ...targetOnHost(
      state,
      worktreeId,
      getExecutionHostIdForWorktree(state, worktreeId),
      executionHostId
    ),
    workspacePath,
    projectRuntime: () => getLocalProjectExecutionRuntimeContext(state, worktreeId)
  })
}

/**
 * An existing workspace's terminal host, from its resource owner alone (ownership slices, never
 * settings or connection facts), for observers that must not re-derive on a focus change.
 */
export function resolveWorktreeResourceTarget(
  state: Omit<WorktreeHostFactsState, 'settings'>,
  worktreeId: string
): ExecutionHostTarget {
  return targetOnHost(state, worktreeId, getResourceExecutionHostIdForWorktree(state, worktreeId))
}

function targetOnHost(
  state: Omit<WorktreeHostFactsState, 'settings'>,
  worktreeId: string,
  hostId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostTarget {
  const host = parseExecutionHostId(hostId)
  return {
    host,
    nestedSshTargetId:
      host?.kind === 'runtime'
        ? ((executionHostId
            ? getConnectionIdForWorktreeCopy(state, worktreeId, executionHostId)
            : getConnectionIdFromState(state, worktreeId)) ?? null)
        : null,
    sshOwnerEnvironmentId:
      host?.kind === 'ssh' ? runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId) : null
  }
}

export type KnownExecutionHostPlatform = Extract<ExecutionHostPlatformFact, { kind: 'known' }>

/** A caller's platform only refines a local launch (e.g. WSL); a remote host's own OS wins. */
export function refineLocalLaunchPlatform(
  fact: KnownExecutionHostPlatform,
  callerPlatform: NodeJS.Platform | undefined
): KnownExecutionHostPlatform {
  return fact.hostKind === 'local' && callerPlatform ? { ...fact, platform: callerPlatform } : fact
}

/** Preflight worktree-owner platform, then repo owner; undefined defers withheld-host errors to launch resolution. */
export function resolveRepoWorktreeLaunchPlatform(
  state: WorktreeHostFactsState,
  repo: { connectionId?: string | null; executionHostId?: string | null; path: string },
  worktree: {
    id: string
    path?: string | null
    hostId?: string | null
    runtimeOwnerEnvironmentId?: string | null
  }
): NodeJS.Platform | undefined {
  const fact = resolveRepoWorktreePlatformFact(state, repo, worktree)
  return fact.kind === 'known' ? fact.platform : undefined
}

function resolveRepoWorktreePlatformFact(
  state: WorktreeHostFactsState,
  repo: Parameters<typeof resolveRepoWorktreeLaunchPlatform>[1],
  worktree: Parameters<typeof resolveRepoWorktreeLaunchPlatform>[2]
): ExecutionHostPlatformFact {
  const repoHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  const ownHost = parseExecutionHostId(worktree.hostId)
  // Why: a per-worktree host (e.g. a local checkout of a server project) outranks the repo's.
  const host = ownHost && ownHost.id !== repoHost?.id ? ownHost : repoHost
  const serverOwner =
    worktree.runtimeOwnerEnvironmentId?.trim() ||
    (repoHost?.kind === 'runtime' ? repoHost.environmentId : null)
  return resolveHostPlatform(state, {
    host,
    nestedSshTargetId:
      host?.kind === 'runtime' && host === repoHost ? repo.connectionId?.trim() || null : null,
    // Why: a server-projected SSH worktree is reached through that server's own connection.
    sshOwnerEnvironmentId: host?.kind === 'ssh' ? serverOwner : null,
    workspacePath: worktree.path ?? repo.path,
    projectRuntime: () => getLocalProjectExecutionRuntimeContext(state, worktree.id)
  })
}

export function requireExecutionHostPlatform(fact: ExecutionHostPlatformFact): NodeJS.Platform {
  if (fact.kind === 'withheld') {
    throw new Error(fact.reason)
  }
  return fact.platform
}

/** `terminalWindowsShell` is this client's setting, so a remote host uses only the shell it reported. */
export function resolveExecutionHostAgentStartupShell(
  fact: ExecutionHostPlatformFact,
  terminalWindowsShell: string | null | undefined
): AgentStartupShell | undefined {
  return fact.kind === 'known'
    ? resolveHostAgentStartupShell({
        platform: fact.platform,
        isRemote: fact.hostKind !== 'local',
        hostTerminalWindowsShell:
          fact.hostKind === 'local' ? terminalWindowsShell : fact.terminalWindowsShell
      })
    : undefined
}
