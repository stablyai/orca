import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree/id'

export function addHydratedSshWorktreePlaceholders(
  repos: readonly Repo[],
  sourceWorktreesByRepo: Record<string, Worktree[]>,
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, Worktree[]> {
  const sshRepoIds = new Set(repos.filter((repo) => repo.connectionId).map((repo) => repo.id))
  // Why copy-on-write: hydration writes this map straight to the store, and a session
  // that needs no SSH placeholder is the common case. Copying unconditionally gave
  // worktreesByRepo a new identity on every hydration, rerendering the sidebar and
  // everything else selecting the whole map for no data change.
  let worktreesByRepo = sourceWorktreesByRepo
  for (const worktreeId of Object.keys(tabsByWorktree)) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (!sshRepoIds.has(repoId)) {
      continue
    }
    if ((worktreesByRepo[repoId] ?? []).some((worktree) => worktree.id === worktreeId)) {
      continue
    }
    // Strip synthetic folder suffixes so the placeholder path remains a valid cwd.
    const path = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? ''
    const displayName = path.split(/[/\\]/).pop() || path
    const placeholder: Worktree = {
      id: worktreeId,
      repoId,
      displayName,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      path,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: false
    }
    if (worktreesByRepo === sourceWorktreesByRepo) {
      worktreesByRepo = { ...sourceWorktreesByRepo }
    }
    worktreesByRepo[repoId] = [...(worktreesByRepo[repoId] ?? []), placeholder]
  }
  return worktreesByRepo
}
