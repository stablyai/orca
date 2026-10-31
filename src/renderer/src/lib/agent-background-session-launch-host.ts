import {
  hostRouteForAuthority,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/runtime-client-target'
import { resolveOwner } from './resolve-owner'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { useAppStore } from '@/store'
import {
  requireExecutionHostPlatform,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { launchHostIsRemote } from '../../../shared/agent-launch-remote'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import type { ResolvedAgentBackgroundTarget } from './agent-background-session-contract'

type LaunchStore = ReturnType<typeof useAppStore.getState>
type LaunchRepo = LaunchStore['repos'][number]

export type AgentBackgroundLaunchHost = {
  /** SSH connection to spawn on, or null for a local launch. */
  connectionId: string | null
  /** Platform whose shell quoting and CLI naming the startup plan must target. */
  platform: NodeJS.Platform
  isRemote: boolean
  /** Only a local host's shell is the one this client's terminal setting describes. */
  isLocalHost: boolean
  /** Accepted status connection; undefined preserves unknown-owner behavior. */
  expectedConnectionId: string | null | undefined
}

function resolveFolderWorkspaceConnectionIdForLaunch(
  store: LaunchStore,
  worktreeId: string
): string | null | undefined {
  const parsed = parseWorkspaceKey(worktreeId)
  if (parsed?.type !== 'folder') {
    return undefined
  }
  return getFolderWorkspaceConnectionId(store, parsed.folderWorkspaceId)
}

// Why the worktree, not the repo: a per-worktree host (nested SSH) outranks the repo's default.
function resolveLaunchHostFact(
  store: LaunchStore,
  worktreeId: string,
  worktreePath: string | undefined,
  resolvedTarget?: ResolvedAgentBackgroundTarget
): Pick<AgentBackgroundLaunchHost, 'platform' | 'isLocalHost'> & { isRemoteHost: boolean } {
  const fact = resolveWorktreeExecutionHostPlatform(store, worktreeId, worktreePath, resolvedTarget)
  return {
    platform: requireExecutionHostPlatform(fact),
    isLocalHost: fact.kind === 'known' && fact.hostKind === 'local',
    isRemoteHost: fact.kind === 'known' && launchHostIsRemote(fact.hostKind, worktreePath)
  }
}

/** Resolves folder launch ownership from workspace scope when no repo row exists. */
export function resolveAgentBackgroundLaunchHost(args: {
  store: LaunchStore
  worktreeId: string
  worktreePath: string | undefined
  repo: LaunchRepo | null | undefined
  resolvedTarget?: ResolvedAgentBackgroundTarget
}): AgentBackgroundLaunchHost {
  const { store, worktreeId, worktreePath, repo } = args
  if (repo) {
    // Why: SSH ownership has two spellings, so the raw field spawns an `executionHostId: 'ssh:*'`-only
    // repo on the client with a remote path. One resolution feeds the route, the trust write and the
    // launch shape, which must not disagree about the host.
    const selectedHost = parseExecutionHostId(args.resolvedTarget?.worktree.hostId)
    const sshConnectionId =
      selectedHost?.kind === 'local'
        ? null
        : selectedHost?.kind === 'ssh'
          ? selectedHost.targetId
          : getRepoSshConnectionId(repo)
    const { isRemoteHost, ...hostFact } = resolveLaunchHostFact(
      store,
      worktreeId,
      worktreePath,
      args.resolvedTarget
    )
    return {
      connectionId: sshConnectionId,
      ...hostFact,
      isRemote: args.resolvedTarget
        ? !hostFact.isLocalHost
        : sshConnectionId !== null || isRemoteHost,
      expectedConnectionId: sshConnectionId
    }
  }
  const folderWorkspaceConnectionId = resolveFolderWorkspaceConnectionIdForLaunch(store, worktreeId)
  const isFolderWorkspace = parseWorkspaceKey(worktreeId)?.type === 'folder'
  if (isFolderWorkspace && folderWorkspaceConnectionId === undefined) {
    throw new Error('The target folder workspace host is unavailable or ambiguous.')
  }
  const { isRemoteHost, ...hostFact } = resolveLaunchHostFact(store, worktreeId, worktreePath)
  return {
    connectionId: folderWorkspaceConnectionId ?? null,
    ...hostFact,
    isRemote: Boolean(folderWorkspaceConnectionId) || isRemoteHost,
    expectedConnectionId: isFolderWorkspace ? (folderWorkspaceConnectionId ?? null) : undefined
  }
}

export function resolveAgentBackgroundLaunchContext(
  args: Parameters<typeof resolveAgentBackgroundLaunchHost>[0] & { worktreePath: string }
) {
  const { store, worktreeId, resolvedTarget } = args
  const launchHost = resolveAgentBackgroundLaunchHost(args)
  // Route by the worktree's owner host, not the focused runtime.
  const hostId = resolvedTarget
    ? (parseExecutionHostId(resolvedTarget.worktree.hostId)?.id ??
      getRepoExecutionHostId(resolvedTarget.repo))
    : undefined
  const owner = hostId ? resolveOwner(store, { workspaceId: worktreeId, hostId }) : null
  if (hostId && (owner?.kind !== 'resolved' || !store.getKnownWorktreeById(worktreeId, hostId))) {
    throw new Error('The target workspace is no longer available.')
  }
  const executionFacts = hostId
    ? {
        ...launchHost,
        hostId,
        isWsl: isWslUncPath(args.worktreePath),
        projectRuntime: getLocalProjectExecutionRuntimeContext(
          store,
          worktreeId,
          undefined,
          undefined,
          resolvedTarget
        )
      }
    : undefined
  const runtimeTarget =
    owner?.kind === 'resolved'
      ? hostRouteForAuthority(owner.owner).target
      : runtimeTargetForOwnerEnvironment(runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId))
  return { launchHost, runtimeTarget, executionFacts }
}
