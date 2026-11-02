import type { AppState } from '@/store'
import type { ExecutionHostOwnerRow } from '../../../shared/worktree-execution-host-resolution'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import {
  isLocalExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/qualified-worktree-execution-owner'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resolveQualifiedIndexedFolderWorkspace,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

type WatchTargetRowState = Pick<
  AppState,
  'worktreesByRepo' | 'repos' | 'folderWorkspaces' | 'projectGroups'
>

export type EditorExternalWatchTargetRows = {
  worktree: AppState['worktreesByRepo'][string][number] | undefined
  repo: ExecutionHostOwnerRow | undefined
  folderWorkspace: AppState['folderWorkspaces'][number] | undefined
  projectGroup: AppState['projectGroups'][number] | undefined
  connectionId: string | null | undefined
}

/** The catalog rows for one watch consumer, taken from the row on that consumer's own execution host. */
export function resolveEditorExternalWatchTargetRows(
  state: WatchTargetRowState,
  worktreeId: string,
  hostId: ExecutionHostId | null
): EditorExternalWatchTargetRows | null {
  const worktreeOwner = resolveQualifiedWorktreeExecutionOwner(
    selectWorktreesByRepo(state),
    state.repos,
    worktreeId,
    hostId
  )
  const worktree = worktreeOwner?.worktree
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const qualifiedFolder =
    workspaceScope?.type === 'folder'
      ? resolveQualifiedIndexedFolderWorkspace(
          state,
          workspaceScope.folderWorkspaceId,
          hostId ?? undefined
        )
      : null
  const selectedFolder = qualifiedFolder?.kind === 'selected' ? qualifiedFolder.value : null
  const folderWorkspace = selectedFolder?.workspace
  if (!worktree && !folderWorkspace) {
    return null
  }
  const repo = worktreeOwner?.kind === 'resolved' ? (worktreeOwner.owner ?? undefined) : undefined
  const folderHost = parseExecutionHostId(
    selectedFolder?.hostId ?? folderWorkspace?.executionHostId
  )
  const projectGroup = folderWorkspace
    ? state.projectGroups.find(
        (group) =>
          group.id === folderWorkspace.projectGroupId &&
          parseExecutionHostId(group.executionHostId)?.id === folderHost?.id
      )
    : undefined
  const connectionId = selectedFolder
    ? selectedFolder.connectionId
    : worktreeOwner?.kind === 'resolved'
      ? worktreeOwner.connectionId
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
