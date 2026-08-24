import type { Repo } from './repo-types'
import { isFolderRepo } from './repo-kind'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  WORKTREE_ID_SEPARATOR,
  isWorkspaceInstanceWorktreeId
} from './worktree/id'

/**
 * A *workspace instance* is a card that shares its project's existing checkout instead of owning
 * one. Folder projects have always worked this way (every card points at the same directory); a
 * git project gets them as **terminal groups** — extra terminal/agent cards on the main checkout,
 * with no worktree and no branch of their own.
 *
 * Both wear the same id shape, so one predicate answers "does this card own a checkout?" for the
 * git surfaces (source control, PRs, branch actions) that must degrade for either.
 */
export type WorkspaceInstanceRepo = Pick<Repo, 'id' | 'path'>

/** Row that owns the project's checkout: the folder root, or a git project's main worktree. */
export function getProjectCheckoutWorktreeId(repo: WorkspaceInstanceRepo): string {
  return `${repo.id}${WORKTREE_ID_SEPARATOR}${repo.path}`
}

export function buildWorkspaceInstanceWorktreeId(
  repo: WorkspaceInstanceRepo,
  instanceId: string
): string {
  return `${getProjectCheckoutWorktreeId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
}

export function isWorkspaceInstanceWorktreeIdForRepo(
  repo: WorkspaceInstanceRepo,
  worktreeId: string
): boolean {
  return (
    worktreeId.startsWith(
      `${getProjectCheckoutWorktreeId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
    ) && isWorkspaceInstanceWorktreeId(worktreeId)
  )
}

export function getWorkspaceInstanceIdentity(
  repo: WorkspaceInstanceRepo,
  worktreeId: string
): string | null {
  if (!isWorkspaceInstanceWorktreeIdForRepo(repo, worktreeId)) {
    return null
  }
  return worktreeId.slice(
    `${getProjectCheckoutWorktreeId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`.length
  )
}

/** A terminal group is a workspace instance on a git project — folder projects call theirs workspaces. */
export function isTerminalGroupWorktreeId(
  repo: Pick<Repo, 'kind'> | null | undefined,
  worktreeId: string
): boolean {
  return Boolean(repo) && !isFolderRepo(repo!) && isWorkspaceInstanceWorktreeId(worktreeId)
}

/**
 * True when the workspace has no checkout of its own, so every git surface must degrade: the whole
 * of a folder project, and a git project's terminal groups.
 */
export function sharesProjectCheckout(
  repo: Pick<Repo, 'kind'> | null | undefined,
  worktreeId: string | null | undefined
): boolean {
  if (repo && isFolderRepo(repo)) {
    return true
  }
  return typeof worktreeId === 'string' && isWorkspaceInstanceWorktreeId(worktreeId)
}
