import type {
  AddRepoExistingWorkspaceSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { Worktree } from '../../../../shared/types'

type ExistingWorkspacesDetectedProps = EventProps<'add_repo_existing_workspaces_detected'>

const MAX_REPORTED_WORKSPACES = 50

function countWorkspaces(count: number): number {
  return Math.min(MAX_REPORTED_WORKSPACES, Math.max(0, count))
}

function branchDisplayName(worktree: Worktree): string {
  return worktree.branch.replace(/^refs\/heads\//, '')
}

function pathBasename(pathValue: string): string {
  return (
    pathValue
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

function isCustomDisplayName(worktree: Worktree): boolean {
  const branchName = branchDisplayName(worktree)
  const pathName = pathBasename(worktree.path)
  return Boolean(
    worktree.displayName && worktree.displayName !== branchName && worktree.displayName !== pathName
  )
}

export function buildAddRepoExistingWorkspacesTelemetry(
  source: AddRepoExistingWorkspaceSource | null,
  worktrees: readonly Worktree[]
): ExistingWorkspacesDetectedProps | null {
  if (!source || worktrees.length === 0) {
    return null
  }

  const mainWorkspaceCount = worktrees.filter((worktree) => worktree.isMainWorktree).length
  const branchNamedWorkspaceCount = worktrees.filter((worktree) =>
    Boolean(branchDisplayName(worktree))
  ).length
  const sparseWorkspaceCount = worktrees.filter((worktree) => worktree.isSparse === true).length

  return {
    source,
    existing_workspace_count: countWorkspaces(worktrees.length),
    existing_linked_workspace_count: countWorkspaces(worktrees.length - mainWorkspaceCount),
    main_workspace_count: countWorkspaces(mainWorkspaceCount),
    branch_named_workspace_count: countWorkspaces(branchNamedWorkspaceCount),
    detached_workspace_count: countWorkspaces(worktrees.length - branchNamedWorkspaceCount),
    custom_named_workspace_count: countWorkspaces(worktrees.filter(isCustomDisplayName).length),
    sparse_workspace_count: countWorkspaces(sparseWorkspaceCount)
  }
}

export function buildAddRepoExistingWorkspacesDetectedEvent(
  source: AddRepoExistingWorkspaceSource,
  worktrees: readonly Worktree[]
): ExistingWorkspacesDetectedProps | null {
  const sortedWorktrees = [...worktrees].sort((a, b) => {
    if (a.lastActivityAt !== b.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt
    }
    return a.displayName.localeCompare(b.displayName)
  })
  const payload = buildAddRepoExistingWorkspacesTelemetry(source, sortedWorktrees)
  return payload && shouldTrackAddRepoExistingWorkspacesDetected(payload) ? payload : null
}

export function shouldTrackAddRepoExistingWorkspacesDetected(
  payload: ExistingWorkspacesDetectedProps | null
): boolean {
  // Track the import/discovery signal, not mere setup-modal exposure: the main
  // checkout is always a worktree, but only non-main worktrees imply migration.
  if (!payload || payload.existing_linked_workspace_count === 0) {
    return false
  }

  // Clone/create produce a new project during this flow, so their setup step is
  // not evidence of a pre-existing workspace migration opportunity.
  return (
    payload.source === 'local_folder_picker' ||
    payload.source === 'runtime_server_path' ||
    payload.source === 'ssh_remote_path'
  )
}
