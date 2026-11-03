import type { AppState } from '@/store/types'
import { getWorktreeMapFromState } from '@/store/selectors'
import { getConnectionIdFromState } from '@/lib/connection-context'
import type { TerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { resolveWorktreeOperationRouteForHost } from '@/lib/worktree-operation-route'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../shared/ephemeral-setup-terminal-worktree-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import {
  getRepoExecutionHostId,
  getConnectionExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  UNRESOLVED_OWNER_HOST_ID
} from '../../../../shared/execution-host'
import {
  findLocalFolderWorkspaceRuntimeRepo,
  resolveQualifiedFolderWorkspaceResult
} from '../../../../shared/folder-workspace-execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'

export function resolveTerminalPaneOwnerContext(
  state: AppState,
  worktreeId: string,
  tabId: string,
  acquiredRoute: TerminalWorktreeRoute | null,
  restoredPtyId?: string | null
) {
  const tab = state.tabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  const tabHost = state.unifiedTabsByWorktree[worktreeId]?.find(
    (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
  )?.executionHostId
  const selectedHost = parseExecutionHostId(tabHost)
  const scope = parseWorkspaceKey(worktreeId)
  const result =
    scope?.type === 'folder'
      ? resolveQualifiedFolderWorkspaceResult(state, scope.folderWorkspaceId, selectedHost?.id)
      : null
  const folder = result?.kind === 'selected' ? result.value : null
  const worktree = folder
    ? folderWorkspaceToWorktree({ ...folder.workspace, executionHostId: folder.hostId })
    : scope?.type === 'folder'
      ? null
      : selectedHost
        ? state.getKnownWorktreeById(worktreeId, selectedHost.id)
        : getWorktreeMapFromState(state).get(worktreeId)
  const repos = worktree
    ? state.repos.filter(
        (repo) =>
          repo.id === worktree.repoId &&
          (!selectedHost || getRepoExecutionHostId(repo) === selectedHost.id)
      )
    : []
  const repo = repos.length === 1 ? repos[0] : undefined
  const runtimeRepo = folder
    ? findLocalFolderWorkspaceRuntimeRepo(state, folder.workspace.id, {
        ...folder.workspace,
        executionHostId: folder.hostId,
        connectionId: folder.connectionId
      })
    : repo
  const projectRuntimeTarget =
    worktree && runtimeRepo
      ? { worktree: folder ? { ...worktree, repoId: runtimeRepo.id } : worktree, repo: runtimeRepo }
      : undefined
  const connectionId = folder
    ? folder.connectionId
    : selectedHost?.kind === 'local'
      ? null
      : selectedHost?.kind === 'ssh'
        ? selectedHost.targetId
        : selectedHost
          ? repo && getRepoSshConnectionId(repo)
          : getConnectionIdFromState(state, worktreeId)
  const route =
    tabHost && !selectedHost
      ? null
      : selectedHost
        ? resolveWorktreeOperationRouteForHost(state, worktreeId, selectedHost.id)
        : acquiredRoute
  const runtimeOwners = new Set(
    (selectedHost || isWebTerminalSurfaceTabId(tabId) ? [restoredPtyId, tab?.ptyId] : [])
      .map((id) => (id ? getRemoteRuntimePtyEnvironmentId(id) : null))
      .filter((id): id is string => Boolean(id))
  )
  const mirroredRuntimeEnvironmentId = runtimeOwners.values().next().value ?? null
  const unresolved =
    runtimeOwners.size > 1 ||
    (route?.runtimeEnvironmentId &&
      mirroredRuntimeEnvironmentId &&
      route.runtimeEnvironmentId !== mirroredRuntimeEnvironmentId) ||
    (!route && !mirroredRuntimeEnvironmentId)
  const runtimeEnvironmentId = route?.runtimeEnvironmentId ?? mirroredRuntimeEnvironmentId
  const executionHostId = unresolved
    ? UNRESOLVED_OWNER_HOST_ID
    : runtimeEnvironmentId && (!selectedHost || selectedHost.kind === 'local')
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : (selectedHost?.id ??
        parseExecutionHostId(worktree?.hostId)?.id ??
        (repo
          ? getRepoExecutionHostId(repo)
          : connectionId !== undefined ||
              worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
              isEphemeralSetupTerminalWorktreeId(worktreeId)
            ? getConnectionExecutionHostId(connectionId)
            : UNRESOLVED_OWNER_HOST_ID))
  return {
    tab,
    selectedHost,
    folderWorkspace: folder?.workspace ?? null,
    worktree,
    repo,
    projectRuntimeTarget,
    connectionId,
    route,
    runtimeOwners,
    mirroredRuntimeEnvironmentId,
    runtimeEnvironmentId,
    executionHostId,
    unresolved: Boolean(unresolved)
  }
}
