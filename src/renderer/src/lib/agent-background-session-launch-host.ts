import type { useAppStore } from '@/store'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { getRepoSshConnectionId } from '../../../shared/execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'

type LaunchStore = ReturnType<typeof useAppStore.getState>
type LaunchRepo = LaunchStore['repos'][number]

export type AgentBackgroundLaunchHost = {
  /** SSH connection to spawn on, or null for a local launch. */
  connectionId: string | null
  /** Platform whose shell quoting and CLI naming the startup plan must target. */
  platform: NodeJS.Platform
  isRemote: boolean
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

/** Resolves folder launch ownership from workspace scope when no repo row exists. */
export function resolveAgentBackgroundLaunchHost(args: {
  store: LaunchStore
  worktreeId: string
  worktreePath: string | undefined
  repo: LaunchRepo | null | undefined
}): AgentBackgroundLaunchHost {
  const { store, worktreeId, worktreePath, repo } = args
  if (repo) {
    // Why: SSH ownership has two spellings, so the raw field spawns an `executionHostId: 'ssh:*'`-only
    // repo on the client with a remote path. One resolution feeds the route, the trust write and the
    // launch shape, which must not disagree about the host.
    const sshConnectionId = getRepoSshConnectionId(repo)
    return {
      connectionId: sshConnectionId,
      platform: getAgentLaunchPlatformForRepo(
        repo,
        sshConnectionId ? undefined : getLocalProjectExecutionRuntimeContext(store, worktreeId)
      ),
      isRemote: repoIsRemote(repo),
      expectedConnectionId: sshConnectionId
    }
  }
  const folderWorkspaceConnectionId = resolveFolderWorkspaceConnectionIdForLaunch(store, worktreeId)
  const isFolderWorkspace = parseWorkspaceKey(worktreeId)?.type === 'folder'
  if (isFolderWorkspace && folderWorkspaceConnectionId === undefined) {
    throw new Error('The target folder workspace host is unavailable or ambiguous.')
  }
  return {
    connectionId: folderWorkspaceConnectionId ?? null,
    platform: folderWorkspaceConnectionId
      ? isWindowsAbsolutePathLike(worktreePath ?? '')
        ? 'win32'
        : 'linux'
      : isWslUncPath(worktreePath ?? '')
        ? 'linux'
        : CLIENT_PLATFORM,
    isRemote: Boolean(folderWorkspaceConnectionId),
    expectedConnectionId: isFolderWorkspace ? (folderWorkspaceConnectionId ?? null) : undefined
  }
}
