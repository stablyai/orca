import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

export type WorkspaceRepoStripEntry = {
  /** Workspace key to activate: the folder key for "All", the worktree id for a repo. */
  key: string
  kind: 'all' | 'repo'
  label: string
  active: boolean
  /** Null when the count is unknown; never rendered as "clean". */
  changedCount: number | null
}

export type WorkspaceRepoStripModel = {
  folderWorkspace: FolderWorkspace
  entries: WorkspaceRepoStripEntry[]
}

type StripInput = {
  activeWorktreeId: string | null
  folderWorkspaces: readonly FolderWorkspace[]
  repos: readonly Repo[]
  gitStatusByWorktree: Readonly<Record<string, readonly GitStatusEntry[] | undefined>>
}

/**
 * The strip for the active workspace, or null outside a multi-repo workspace and its repos.
 * Only ready members navigate anywhere, so failed or queued ones stay in the sidebar and the root panel.
 */
export function buildWorkspaceRepoStripModel({
  activeWorktreeId,
  folderWorkspaces,
  repos,
  gitStatusByWorktree
}: StripInput): WorkspaceRepoStripModel | null {
  if (!activeWorktreeId) {
    return null
  }
  for (const folderWorkspace of folderWorkspaces) {
    const multiRepo = folderWorkspace.multiRepo
    if (!multiRepo) {
      continue
    }
    const rootKey = folderWorkspaceKey(folderWorkspace.id)
    const readyMembers = multiRepo.members.filter(
      (member) => member.state === 'ready' && member.worktreeId
    )
    const isActive =
      activeWorktreeId === rootKey ||
      readyMembers.some((member) => member.worktreeId === activeWorktreeId)
    if (!isActive) {
      continue
    }
    const entries: WorkspaceRepoStripEntry[] = [
      {
        key: rootKey,
        kind: 'all',
        label: '',
        active: activeWorktreeId === rootKey,
        changedCount: null
      }
    ]
    for (const member of readyMembers) {
      const worktreeId = member.worktreeId ?? ''
      const status = gitStatusByWorktree[worktreeId]
      entries.push({
        key: worktreeId,
        kind: 'repo',
        label: repos.find((repo) => repo.id === member.repoId)?.displayName ?? member.dirName,
        active: activeWorktreeId === worktreeId,
        changedCount: status ? status.length : null
      })
    }
    return { folderWorkspace, entries }
  }
  return null
}
