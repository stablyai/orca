import React, { useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { findKnownWorktreeById } from '../../store/slices/worktrees/listing/detected-worktree-meta'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  Metric,
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import { MetricPair, ROW_TRAILING_GUTTER_CLS } from './resource-usage-metrics'
import { WorktreeRow } from './resource-usage-session-rows'
import { resolveResourceManagerWorkspaceExecutionHostId } from './resource-manager-workspace-owner'

export type SortOption = 'memory' | 'cpu' | 'name'

// ─── Sorting ────────────────────────────────────────────────────────

function compareMetricDesc(a: Metric, b: Metric): number {
  // Why: null metrics (remote rows) sort last regardless of direction so they don't pollute the "biggest consumers" view.
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

function sortWorktrees(list: UnifiedWorktreeRow[], sort: SortOption): UnifiedWorktreeRow[] {
  const copy = [...list]
  if (sort === 'memory') {
    copy.sort((a, b) => compareMetricDesc(a.memory, b.memory))
  } else if (sort === 'cpu') {
    copy.sort((a, b) => compareMetricDesc(a.cpu, b.cpu))
  } else {
    copy.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName))
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
    copy.sort((a, b) => a.repoName.localeCompare(b.repoName))
  }
  return copy
}

// ─── Repo + worktree tree ───────────────────────────────────────────

export function ResourceTree({
  repos,
  activeHostId,
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
  readOnly
}: {
  repos: UnifiedProjectGroup[]
  activeHostId: string
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
  readOnly: boolean
}): React.JSX.Element {
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const detectedWorktreesByRepo = useAppStore((state) => state.detectedWorktreesByRepo)
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const catalogRepos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const runtimeEnvironmentCatalogHydrated = useAppStore(
    (state) => state.runtimeEnvironmentCatalogHydrated
  )
  const removedRuntimeEnvironmentIds = useAppStore((state) => state.removedRuntimeEnvironmentIds)
  const restoredRuntimeHostIdByWorkspaceSessionKey = useAppStore(
    (state) => state.restoredRuntimeHostIdByWorkspaceSessionKey
  )
  const activeWorkspaceExecutionHostId = useAppStore(
    (state) => state.activeWorkspaceExecutionHostId
  )
  const storeRecordById = useMemo(() => {
    const map = new Map<string, Worktree>()
    const ownerState = {
      worktreesByRepo,
      detectedWorktreesByRepo,
      folderWorkspaces,
      projectGroups,
      repos: catalogRepos,
      settings,
      runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds,
      restoredRuntimeHostIdByWorkspaceSessionKey,
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    }
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        const executionHostId = resolveResourceManagerWorkspaceExecutionHostId(
          ownerState,
          worktree.worktreeId,
          activeHostId
        )
        if (!executionHostId) {
          continue
        }
        const record = findKnownWorktreeById(
          { worktreesByRepo, detectedWorktreesByRepo, folderWorkspaces },
          worktree.worktreeId,
          executionHostId
        )
        if (record) {
          map.set(worktree.worktreeId, record)
        }
      }
    }
    return map
  }, [
    repos,
    activeHostId,
    worktreesByRepo,
    detectedWorktreesByRepo,
    folderWorkspaces,
    projectGroups,
    catalogRepos,
    settings,
    runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds,
    restoredRuntimeHostIdByWorkspaceSessionKey,
    activeWorktreeId,
    activeWorkspaceExecutionHostId
  ])

  const sortedRepos = useMemo(() => {
    const grouped = sortProjectGroups(repos, sortOption)
    return grouped.map((repo) => ({
      ...repo,
      worktrees: sortWorktrees(repo.worktrees, sortOption)
    }))
  }, [repos, sortOption])

  const renderWorktree = (wt: UnifiedWorktreeRow): React.JSX.Element => {
    // Why: the id-keyed map cannot distinguish twins; resolve display/action
    // metadata through the same host-qualified catalog boundary as navigation.
    const storeRecord = storeRecordById.get(wt.worktreeId) ?? null
    return (
      <WorktreeRow
        key={wt.worktreeId}
        worktree={wt}
        storeRecord={storeRecord}
        activeWorktreeId={activeWorktreeId}
        isCollapsed={collapsedWorktrees.has(wt.worktreeId)}
        onToggle={() => toggleWorktree(wt.worktreeId)}
        onNavigate={() => navigateToWorktree(wt.worktreeId)}
        onDelete={() => onDelete(wt.worktreeId)}
        onKillSession={onKillSession}
        navigateToTab={navigateToTab}
        readOnly={readOnly}
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
                  <MetricPair cpu={group.cpu} memory={group.memory} />
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
