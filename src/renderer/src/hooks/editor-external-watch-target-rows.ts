import type { AppState } from '@/store'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import {
  isLocalExecutionHost,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

type WatchTargetRowState = Pick<
  AppState,
  'worktreesByRepo' | 'repos' | 'folderWorkspaces' | 'projectGroups'
>

export type EditorExternalWatchTargetRows = {
  worktree: AppState['worktreesByRepo'][string][number] | undefined
  repo: AppState['repos'][number] | undefined
  folderWorkspace: AppState['folderWorkspaces'][number] | undefined
  projectGroup: AppState['projectGroups'][number] | undefined
  connectionId: string | null | undefined
}

function pickHostRow<T>(
  rows: readonly T[],
  hostId: ExecutionHostId | null,
  rowHostId: (row: T) => string | null | undefined
): T | undefined {
  // Why: hosts can publish the same workspace id with different roots; a first-row pick would watch another host's path.
  const onHost = hostId
    ? rows.find((row) => parseExecutionHostId(rowHostId(row))?.id === hostId)
    : undefined
  return onHost ?? rows[0]
}

/** The catalog rows for one watch consumer, taken from the row on that consumer's own execution host. */
export function resolveEditorExternalWatchTargetRows(
  state: WatchTargetRowState,
  worktreeId: string,
  hostId: ExecutionHostId | null
): EditorExternalWatchTargetRows | null {
  const worktree = pickHostRow(
    getIndexedWorktreesById(state.worktreesByRepo, worktreeId),
    hostId,
    (row) =>
      row.hostId ??
      (row.runtimeOwnerEnvironmentId?.trim()
        ? toRuntimeExecutionHostId(row.runtimeOwnerEnvironmentId.trim())
        : null)
  )
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const folderWorkspace =
    workspaceScope?.type === 'folder'
      ? pickHostRow(
          state.folderWorkspaces.filter(
            (workspace) => workspace.id === workspaceScope.folderWorkspaceId
          ),
          hostId,
          (row) => row.executionHostId
        )
      : undefined
  if (!worktree && !folderWorkspace) {
    return null
  }
  const worktreeHost = parseExecutionHostId(worktree?.hostId)
  const repo = worktree
    ? worktreeHost
      ? (findRepoForHost(state.repos, worktree.repoId, { hostId: worktreeHost.id }) ??
        (worktreeHost.kind === 'local'
          ? undefined
          : state.repos.find((candidate) => candidate.id === worktree.repoId)))
      : state.repos.find((candidate) => candidate.id === worktree.repoId)
    : undefined
  const folderHost = parseExecutionHostId(folderWorkspace?.executionHostId)
  const projectGroup = folderWorkspace
    ? state.projectGroups.find(
        (group) =>
          group.id === folderWorkspace.projectGroupId &&
          parseExecutionHostId(group.executionHostId)?.id === folderHost?.id
      )
    : undefined
  const connectionId = folderWorkspace
    ? folderHost
      ? folderHost.kind === 'ssh'
        ? folderHost.targetId
        : null
      : getFolderWorkspaceConnectionId(state, folderWorkspace.id)
    : repo
      ? (repo.connectionId ?? null)
      : undefined
  return { worktree, repo, folderWorkspace, projectGroup, connectionId }
}

/** Only a proven-local Windows owner may match WSL alias paths for its watch root. */
export function canWatchLocalWindowsWslAliases(
  args: EditorExternalWatchTargetRows & {
    worktreePath: string
    runtimeEnvironmentId: string | null
  }
): boolean {
  if (
    args.runtimeEnvironmentId !== null ||
    args.connectionId !== null ||
    !isWindowsAbsolutePathLike(args.worktreePath)
  ) {
    return false
  }
  if (args.worktree) {
    return (
      !!args.repo &&
      !args.worktree.runtimeOwnerEnvironmentId?.trim() &&
      isLocalExecutionHost(args.worktree.hostId) &&
      isLocalExecutionHost(args.repo.executionHostId)
    )
  }
  return (
    !!args.folderWorkspace &&
    isLocalExecutionHost(args.folderWorkspace.executionHostId) &&
    isLocalExecutionHost(args.projectGroup?.executionHostId)
  )
}
