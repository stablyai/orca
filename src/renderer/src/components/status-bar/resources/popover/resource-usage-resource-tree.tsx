import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useWorktreeMap } from '../../../../store/slices/worktrees/listing/use-worktree-catalog'
import type {
  Metric,
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from '../workspace-attribution/resource-usage-merge-types'
import { MetricPair, ROW_TRAILING_GUTTER_CLS } from './resource-usage-metrics'
import { RuntimePaneTitlesProvider, WorktreeRow } from './resource-usage-session-rows'

export type SortOption = 'memory' | 'cpu' | 'name'

function compareMetricDesc(a: Metric, b: Metric): number {
  // Keep unsampled rows after measured consumers in descending metric sorts.
  if (a === null && b === null) {
    return 0
  }
  if (a === null) {
    return 1
  }
  if (b === null) {
    return -1
  }
  return b - a
}

// Locale order can call distinct ids equal; code units never do.
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortWorktrees(list: UnifiedWorktreeRow[], sort: SortOption): UnifiedWorktreeRow[] {
  const copy = [...list]
  if (sort === 'memory') {
    copy.sort((a, b) => compareMetricDesc(a.memory, b.memory))
  } else if (sort === 'cpu') {
    copy.sort((a, b) => compareMetricDesc(a.cpu, b.cpu))
  } else {
    // Ties keep a fixed order, whichever source a workspace's row came from.
    copy.sort(
      (a, b) =>
        a.worktreeName.localeCompare(b.worktreeName) || compareCodeUnits(a.worktreeId, b.worktreeId)
    )
  }
  return copy
}

function sortProjectGroups(groups: UnifiedProjectGroup[], sort: SortOption): UnifiedProjectGroup[] {
  const copy = [...groups]
  if (sort === 'memory') {
    copy.sort((a, b) => compareMetricDesc(a.memory, b.memory))
  } else if (sort === 'cpu') {
    copy.sort((a, b) => compareMetricDesc(a.cpu, b.cpu))
  } else {
    copy.sort(
      (a, b) => a.repoName.localeCompare(b.repoName) || compareCodeUnits(a.repoId, b.repoId)
    )
  }
  return copy
}

type ProjectRowsProps = {
  activeWorktreeId: string | null
  collapsedWorktrees: Set<string>
  worktreeById: ReturnType<typeof useWorktreeMap>
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
  onDelete: (worktreeId: string) => void
  onKillSession: (session: UnifiedSessionRow) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
  onOpenChat: (worktreeId: string, agentSessionId: string, runtimeHostId?: string) => void
}

/** Memoized: an unchanged project skips reconciling its rows when another project or machine updates. */
const ProjectRows = React.memo(function ProjectRows({
  group,
  activeWorktreeId,
  collapsedWorktrees,
  worktreeById,
  toggleWorktree,
  navigateToWorktree,
  onDelete,
  onKillSession,
  navigateToTab,
  onOpenChat
}: ProjectRowsProps & { group: UnifiedProjectGroup }): React.JSX.Element {
  return (
    <>
      {group.worktrees.map((wt) => (
        <WorktreeRow
          key={wt.worktreeId}
          worktree={wt}
          storeRecord={worktreeById.get(wt.worktreeId) ?? null}
          isActive={wt.worktreeId === activeWorktreeId}
          isCollapsed={collapsedWorktrees.has(wt.worktreeId)}
          onToggle={toggleWorktree}
          onNavigate={navigateToWorktree}
          onDelete={onDelete}
          onKillSession={onKillSession}
          navigateToTab={navigateToTab}
          onOpenChat={onOpenChat}
        />
      ))}
    </>
  )
})

export function ResourceTree({
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
  onKillSession,
  onOpenChat
}: {
  repos: UnifiedProjectGroup[]
  sortOption: SortOption
  collapsedRepos: Set<string>
  toggleRepo: (repoId: string) => void
  collapsedWorktrees: Set<string>
  activeWorktreeId: string | null
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
  onDelete: (worktreeId: string) => void
  onKillSession: (session: UnifiedSessionRow) => void
  onOpenChat: (worktreeId: string, agentSessionId: string, runtimeHostId?: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const worktreeById = useWorktreeMap()

  // The merge keeps an unchanged group's object, so its sorted copy is reused.
  const [sortedGroups] = useState(
    () =>
      new WeakMap<UnifiedProjectGroup, { sortOption: SortOption; sorted: UnifiedProjectGroup }>()
  )
  const sortedRepos = useMemo(
    () =>
      sortProjectGroups(repos, sortOption).map((repo) => {
        const cached = sortedGroups.get(repo)
        if (cached?.sortOption === sortOption) {
          return cached.sorted
        }
        const sorted = { ...repo, worktrees: sortWorktrees(repo.worktrees, sortOption) }
        sortedGroups.set(repo, { sortOption, sorted })
        return sorted
      }),
    [repos, sortOption, sortedGroups]
  )

  const rowProps: ProjectRowsProps = {
    activeWorktreeId,
    collapsedWorktrees,
    worktreeById,
    toggleWorktree,
    navigateToWorktree,
    onDelete,
    onKillSession,
    navigateToTab,
    onOpenChat
  }

  if (sortedRepos.length === 1) {
    return (
      <RuntimePaneTitlesProvider>
        <ProjectRows group={sortedRepos[0]} {...rowProps} />
      </RuntimePaneTitlesProvider>
    )
  }

  return (
    <RuntimePaneTitlesProvider>
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
                    ? t(
                        'auto.components.status.bar.ResourceUsageStatusSegment.b12e31dfcb',
                        'Expand repo'
                      )
                    : t(
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
                      {t(
                        'auto.components.status.bar.ResourceUsageStatusSegment.21cacb16d1',
                        '· remote'
                      )}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <MetricPair cpu={group.cpu} memory={group.memory} />
                  <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
                </div>
              </div>
            </div>

            {!repoCollapsed && (
              <div className="border-t border-border/30">
                <ProjectRows group={group} {...rowProps} />
              </div>
            )}
          </div>
        )
      })}
    </RuntimePaneTitlesProvider>
  )
}
