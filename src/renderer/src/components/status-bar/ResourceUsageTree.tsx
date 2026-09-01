import React, { useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useWorktreeMap } from '../../store/selectors'
import { translate } from '@/i18n/i18n'
import type {
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import type { ResourceUsageSortOption } from './resource-usage-sort'
import { sortResourceUsageProjectGroups, sortResourceUsageWorktrees } from './resource-usage-sort'
import { ResourceUsageMetricPair, ROW_TRAILING_GUTTER_CLS } from './ResourceUsageMetrics'
import { ResourceUsageWorktreeRow } from './ResourceUsageWorktreeRow'

export function ResourceUsageTree({
  repos,
  sortOption,
  collapsedRepos,
  toggleRepo,
  collapsedWorktrees,
  activeWorktreeId,
  toggleWorktree,
  navigateToWorktree,
  navigateToTab,
  onDelete,
  onKillSession
}: {
  repos: UnifiedProjectGroup[]
  sortOption: ResourceUsageSortOption
  collapsedRepos: Set<string>
  toggleRepo: (repoId: string) => void
  collapsedWorktrees: Set<string>
  activeWorktreeId: string | null
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
  onDelete: (worktreeId: string) => void
  onKillSession: (session: UnifiedSessionRow) => void
}): React.JSX.Element {
  const worktreeById = useWorktreeMap()
  const sortedRepos = useMemo(() => {
    const grouped = sortResourceUsageProjectGroups(repos, sortOption)
    return grouped.map((repo) => ({
      ...repo,
      worktrees: sortResourceUsageWorktrees(repo.worktrees, sortOption)
    }))
  }, [repos, sortOption])
  const renderWorktree = (worktree: UnifiedWorktreeRow): React.JSX.Element => {
    const storeRecord = worktreeById.get(worktree.worktreeId) ?? null
    return (
      <ResourceUsageWorktreeRow
        key={worktree.worktreeId}
        worktree={worktree}
        storeRecord={storeRecord}
        activeWorktreeId={activeWorktreeId}
        isCollapsed={collapsedWorktrees.has(worktree.worktreeId)}
        onToggle={() => toggleWorktree(worktree.worktreeId)}
        onNavigate={() => navigateToWorktree(worktree.worktreeId)}
        onDelete={() => onDelete(worktree.worktreeId)}
        onKillSession={onKillSession}
        navigateToTab={navigateToTab}
      />
    )
  }

  if (sortedRepos.length === 1) {
    return <>{sortedRepos[0].worktrees.map(renderWorktree)}</>
  }

  return (
    <>
      {sortedRepos.map((group) => {
        const repoCollapsed = collapsedRepos.has(group.repoId)
        return (
          <div key={group.repoId} className="border-b border-border/50 last:border-b-0">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => toggleRepo(group.repoId)}
                className="pl-2 py-2 pr-0.5 transition-colors hover:bg-muted/50"
                aria-label={
                  repoCollapsed
                    ? translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.b12e31dfcb',
                        'Expand repo'
                      )
                    : translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.73a3fd68a9',
                        'Collapse repo'
                      )
                }
              >
                {repoCollapsed ? (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
              <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
                    {group.repoName}
                  </span>
                  {group.hasRemoteChildren && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">
                      {translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.21cacb16d1',
                        '· remote'
                      )}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <ResourceUsageMetricPair cpu={group.cpu} memory={group.memory} />
                  <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
                </div>
              </div>
            </div>
            {!repoCollapsed && (
              <div className="border-t border-border/30">{group.worktrees.map(renderWorktree)}</div>
            )}
          </div>
        )
      })}
    </>
  )
}
