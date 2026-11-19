import type {
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../../shared/git/history/git-history-types'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'

/** Which changes the Source Control list shows; Staged/Changes/Committed on Branch is `all`. */
export type SourceControlChangeScope =
  | { kind: 'all' }
  | { kind: 'uncommitted' }
  | {
      kind: 'commit'
      commit: GitHistoryItem
      /** The page the commit was picked from, so later pages can prove it left the branch. */
      pickedBaseOid: string | null
      pickedFromBranchPage: boolean
    }

export type SourceControlCommitScopeFiles =
  | { commitId: string; status: 'loading' }
  | { commitId: string; status: 'error'; error: string }
  | { commitId: string; status: 'ready'; entries: GitBranchChangeEntry[] }

export const ALL_CHANGES_SCOPE: SourceControlChangeScope = { kind: 'all' }

// Survives sidebar-tab unmounts for the same worktree; any worktree switch starts at All changes.
let rememberedScope: { worktreeId: string; scope: SourceControlChangeScope; owner: string } | null =
  null

export function readRememberedChangeScope(
  worktreeId: string | null,
  owner: string
): SourceControlChangeScope {
  return worktreeId && rememberedScope?.worktreeId === worktreeId && rememberedScope.owner === owner
    ? rememberedScope.scope
    : ALL_CHANGES_SCOPE
}

export function rememberChangeScope(
  worktreeId: string | null,
  scope: SourceControlChangeScope,
  owner: string
): void {
  rememberedScope = worktreeId ? { worktreeId, scope, owner } : null
}

export function changeScopeKey(scope: SourceControlChangeScope): string {
  return scope.kind === 'commit' ? `commit:${scope.commit.id}` : scope.kind
}

export function commitScopeFromPage(
  commit: GitHistoryItem,
  page: GitHistoryResult
): SourceControlChangeScope {
  return {
    kind: 'commit',
    commit,
    pickedBaseOid: page.branch?.baseRef.revision ?? null,
    pickedFromBranchPage: page.branch !== undefined
  }
}

/** True only when a complete page for the current HEAD and the pick's range lacks the commit. */
export function provesPickedCommitGone(
  scope: Extract<SourceControlChangeScope, { kind: 'commit' }>,
  page: GitHistoryResult,
  statusHead: string | null
): boolean {
  if (page.hasMore || !statusHead || page.currentRef?.revision !== statusHead) {
    return false
  }
  if (page.items.some((item) => item.id === scope.commit.id)) {
    return false
  }
  // A moved base changes the range, so absence would not mean the commit left HEAD.
  return page.branch
    ? scope.pickedFromBranchPage && page.branch.baseRef.revision === scope.pickedBaseOid
    : !scope.pickedFromBranchPage
}

export function shortCommitId(item: GitHistoryItem): string {
  return item.displayId ?? item.id.slice(0, 7)
}

export type ChangeScopeSummary = {
  files: number
  /** Null when any row's counts are unknown (binary, unavailable), so no partial total is shown. */
  lines: { added: number; removed: number } | null
}

export function summarizeChangeScopeEntries(
  entries: readonly { path: string; added?: number; removed?: number }[]
): ChangeScopeSummary {
  const paths = new Set<string>()
  let added = 0
  let removed = 0
  let known = true
  for (const entry of entries) {
    paths.add(entry.path)
    if (entry.added === undefined || entry.removed === undefined) {
      known = false
    } else {
      added += entry.added
      removed += entry.removed
    }
  }
  return { files: paths.size, lines: known ? { added, removed } : null }
}
