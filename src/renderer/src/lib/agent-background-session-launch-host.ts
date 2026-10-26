import type { useAppStore } from '@/store'
import {
  requireExecutionHostPlatform,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { getRepoSshConnectionId } from '../../../shared/execution-host'

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
  worktreePath: string | undefined
): Pick<AgentBackgroundLaunchHost, 'platform' | 'isLocalHost'> & { isSshHost: boolean } {
  const fact = resolveWorktreeExecutionHostPlatform(store, worktreeId, worktreePath)
  return {
    platform: requireExecutionHostPlatform(fact),
    isLocalHost: fact.kind === 'known' && fact.hostKind === 'local',
    // Why: an SSH target (nested ones too) runs the relay shim as plain `orca`.
    isSshHost: fact.kind === 'known' && fact.hostKind === 'ssh'
  }
}

/** Resolves folder launch ownership from workspace scope when no repo row exists. */
export function resolveAgentBackgroundLaunchHost(args: {
  store: LaunchStore
  worktreeId: string
  worktreePath: string | undefined
  repo: LaunchRepo | null | undefined
}): AgentBackgroundLaunchHost {
  const { store, worktreeId, worktreePath, repo } = args
  if (repo) {
    // Resolve both SSH owner spellings once so spawn routing, trust writes and launch shape agree on the host.
    const sshConnectionId = getRepoSshConnectionId(repo)
    const { isSshHost, ...hostFact } = resolveLaunchHostFact(store, worktreeId, worktreePath)
    return {
      connectionId: sshConnectionId,
      ...hostFact,
      isRemote: repoIsRemote(repo) || isSshHost,
      expectedConnectionId: sshConnectionId
    }
  }
  const folderWorkspaceConnectionId = resolveFolderWorkspaceConnectionIdForLaunch(store, worktreeId)
  const isFolderWorkspace = parseWorkspaceKey(worktreeId)?.type === 'folder'
  if (isFolderWorkspace && folderWorkspaceConnectionId === undefined) {
    throw new Error('The target folder workspace host is unavailable or ambiguous.')
  }
  const { isSshHost, ...hostFact } = resolveLaunchHostFact(store, worktreeId, worktreePath)
  return {
    connectionId: folderWorkspaceConnectionId ?? null,
    ...hostFact,
    isRemote: Boolean(folderWorkspaceConnectionId) || isSshHost,
    expectedConnectionId: isFolderWorkspace ? (folderWorkspaceConnectionId ?? null) : undefined
  }
}
