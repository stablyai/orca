import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree/id'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'

type PlaceholderOwner = Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>

/**
 * The owner a listing stamps on this repo row's worktrees. A server's repo that nests an SSH
 * target lists them as `ssh:<target>` through that server, so a bare `runtime:` stamp would hide
 * the target from an `ssh:` host selection.
 */
export function repoRowOwnerStamp(row: Repo): PlaceholderOwner {
  const host = parseExecutionHostId(getRepoExecutionHostId(row))
  const connectionId = row.connectionId?.trim()
  if (host?.kind === 'runtime') {
    return connectionId
      ? {
          hostId: toSshExecutionHostId(connectionId),
          runtimeOwnerEnvironmentId: host.environmentId
        }
      : { hostId: host.id }
  }
  // Why: a row whose explicit host disagrees with its connection is not evidence of either.
  return connectionId && host?.id === toSshExecutionHostId(connectionId) ? { hostId: host.id } : {}
}

/**
 * The SSH host, and the server proxying it, that a listing would stamp. A repo id with rows on
 * several hosts names neither, so its placeholder stays unstamped rather than guessing a twin.
 */
function placeholderOwner(repos: readonly Repo[], repoId: string): PlaceholderOwner {
  const rows = repos.filter((repo) => repo.id === repoId)
  return rows.length === 1 && rows[0].connectionId?.trim() ? repoRowOwnerStamp(rows[0]) : {}
}

export function addHydratedSshWorktreePlaceholders(
  repos: readonly Repo[],
  sourceWorktreesByRepo: Record<string, Worktree[]>,
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, Worktree[]> {
  const sshRepoIds = new Set(repos.filter((repo) => repo.connectionId).map((repo) => repo.id))
  // Why copy-on-write: hydration writes this map straight to the store; an unconditional copy
  // rerendered every whole-map selector on every hydration with no data change.
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
      ...placeholderOwner(repos, repoId),
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
