import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'
import { getAttachedWorktreesForFolderWorkspace } from './folder-workspace-attached-worktrees'
import { FolderWorkspacePrChecksRow } from './FolderWorkspacePrChecksRow'
import {
  buildParentPrChecksProjection,
  type ParentPrChecksRefreshOutcome,
  type ParentPrChecksRow
} from './parent-pr-checks-rows'
import {
  getParentPrChecksRefreshCandidates,
  runLimitedParentPrChecksRefreshes
} from './parent-pr-checks-refresh'

type FolderWorkspacePrChecksPanelProps = {
  isVisible?: boolean
}

export default function FolderWorkspacePrChecksPanel({
  isVisible = true
}: FolderWorkspacePrChecksPanelProps): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const hostedReviewCache = useAppStore((s) => s.hostedReviewCache)
  const prCache = useAppStore((s) => s.prCache)
  const checksCache = useAppStore((s) => s.checksCache)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const fetchPRCheckDetails = useAppStore((s) => s.fetchPRCheckDetails)
  const [refreshOutcomes, setRefreshOutcomes] = useState<
    ReadonlyMap<string, ParentPrChecksRefreshOutcome>
  >(() => new Map())
  const [expandedRowIds, setExpandedRowIds] = useState<ReadonlySet<string>>(() => new Set())
  const [manualRefreshGeneration, setManualRefreshGeneration] = useState(0)
  const lastForcedManualRefreshGenerationRef = useRef(0)

  const { folderWorkspace, childWorktrees } = useMemo(
    () =>
      getAttachedWorktreesForFolderWorkspace({
        activeWorkspaceKey,
        activeWorktreeId,
        folderWorkspaces,
        workspaceLineageByChildKey,
        worktreeLineageById,
        worktreesByRepo
      }),
    [
      activeWorkspaceKey,
      activeWorktreeId,
      folderWorkspaces,
      workspaceLineageByChildKey,
      worktreeLineageById,
      worktreesByRepo
    ]
  )
  const projection = useMemo(
    () =>
      buildParentPrChecksProjection({
        worktrees: childWorktrees,
        repos,
        settings,
        hostedReviewCache,
        prCache,
        checksCache,
        refreshOutcomes
      }),
    [childWorktrees, repos, settings, hostedReviewCache, prCache, checksCache, refreshOutcomes]
  )
  const folderWorkspaceId = folderWorkspace?.id ?? null
  const headerSummary = useMemo(
    () => formatReviewChecksHeaderSummary(projection.summary),
    [projection.summary]
  )
  const refreshCandidates = useMemo(
    () => getParentPrChecksRefreshCandidates({ worktrees: childWorktrees, repos }),
    [childWorktrees, repos]
  )
  const refreshCandidateSignature = useMemo(
    () =>
      refreshCandidates
        .map((candidate) =>
          [
            candidate.identity,
            candidate.repo.path,
            candidate.repo.connectionId ?? '',
            candidate.repo.executionHostId ?? ''
          ].join('|')
        )
        .sort()
        .join(';;'),
    [refreshCandidates]
  )
  const refreshCandidatesRef = useRef(refreshCandidates)

  useEffect(() => {
    refreshCandidatesRef.current = refreshCandidates
  }, [refreshCandidates])

  useEffect(() => {
    const candidates = refreshCandidatesRef.current
    if (!isVisible || !folderWorkspaceId || childWorktrees.length === 0) {
      return
    }
    if (candidates.length === 0) {
      return
    }
    // Why: manual refresh should force exactly one generation; automatic
    // refresh cycles after that must stay cache/staleness-aware.
    const forceRefresh = manualRefreshGeneration > lastForcedManualRefreshGenerationRef.current
    if (forceRefresh) {
      lastForcedManualRefreshGenerationRef.current = manualRefreshGeneration
    }
    let cancelled = false
    void runLimitedParentPrChecksRefreshes({
      candidates,
      concurrency: 3,
      force: forceRefresh,
      fetchHostedReviewForBranch,
      fetchPRChecks,
      onOutcome: (identity, outcome) => {
        if (cancelled) {
          return
        }
        setRefreshOutcomes((current) => new Map(current).set(identity, outcome))
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    isVisible,
    folderWorkspaceId,
    childWorktrees.length,
    fetchHostedReviewForBranch,
    fetchPRChecks,
    refreshCandidateSignature,
    manualRefreshGeneration
  ])

  const currentRefreshIdentities = useMemo(
    () => new Set(refreshCandidates.map((candidate) => candidate.identity)),
    [refreshCandidates]
  )
  const isRefreshing = [...refreshOutcomes.entries()].some(
    ([identity, outcome]) => currentRefreshIdentities.has(identity) && outcome.kind === 'loading'
  )

  useEffect(() => {
    const validRowIds = new Set(projection.rows.map((row) => row.id))
    setExpandedRowIds((current) => {
      const next = new Set([...current].filter((id) => validRowIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [projection.rows])

  const toggleRowExpanded = useCallback((rowId: string): void => {
    setExpandedRowIds((current) => {
      const next = new Set(current)
      if (next.has(rowId)) {
        next.delete(rowId)
      } else {
        next.add(rowId)
      }
      return next
    })
  }, [])

  const loadCheckDetails = useCallback(
    (row: ParentPrChecksRow, check: PRCheckDetail): Promise<PRCheckRunDetails | null> => {
      if (!row.repo) {
        return Promise.resolve(null)
      }
      return fetchPRCheckDetails(
        row.repo.path,
        {
          checkRunId: check.checkRunId,
          workflowRunId: check.workflowRunId,
          checkName: check.name,
          url: check.url,
          prRepo: null
        },
        { repoId: row.repo.id }
      )
    },
    [fetchPRCheckDetails]
  )

  if (!folderWorkspace) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.unavailable',
          'PR checks are only shown for folder workspaces.'
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {translate(
                'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.reviewChecks',
                'Review checks'
              )}
            </div>
            {headerSummary ? (
              <div className="mt-1 truncate text-xs text-muted-foreground">{headerSummary}</div>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setManualRefreshGeneration((generation) => generation + 1)}
                disabled={childWorktrees.length === 0 || isRefreshing}
                aria-label={translate(
                  'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.refresh',
                  'Refresh PR checks'
                )}
              >
                <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {translate(
                'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.refresh',
                'Refresh PR checks'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {childWorktrees.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="text-sm font-medium text-foreground">
            {translate(
              'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.emptyTitle',
              'No attached worktrees yet'
            )}
          </div>
          <div className="mt-2 max-w-[16rem] text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.emptyCopy',
              'PR checks will appear here after worktrees are attached to this folder workspace.'
            )}
          </div>
        </div>
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div className="space-y-1">
            {projection.rows.map((row) => (
              <FolderWorkspacePrChecksRow
                key={row.id}
                row={row}
                expanded={expandedRowIds.has(row.id)}
                onToggle={() => toggleRowExpanded(row.id)}
                onLoadCheckDetails={(check) => loadCheckDetails(row, check)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatReviewChecksHeaderSummary(summary: {
  attached: number
  failing: number
  pending: number
  passing: number
}): string | null {
  if (summary.attached === 0) {
    return null
  }
  const worktreeCount = formatWorktreeCount(summary.attached)
  const attentionParts = [
    summary.failing > 0 ? formatFailingCount(summary.failing) : null,
    summary.pending > 0 ? formatPendingCount(summary.pending) : null
  ].filter((part): part is string => part !== null)

  if (attentionParts.length > 0) {
    return [...attentionParts, worktreeCount].join(' · ')
  }
  if (summary.passing === summary.attached) {
    return [
      worktreeCount,
      translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.allChecksPassing',
        'all checks passing'
      )
    ].join(' · ')
  }
  return worktreeCount
}

function formatWorktreeCount(count: number): string {
  return count === 1
    ? translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.oneWorktree',
        '1 worktree'
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.worktreeCount',
        '{{value0}} worktrees',
        { value0: count }
      )
}

function formatFailingCount(count: number): string {
  return count === 1
    ? translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.oneFailing',
        '1 failing'
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.failingCount',
        '{{value0}} failing',
        { value0: count }
      )
}

function formatPendingCount(count: number): string {
  return count === 1
    ? translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.onePending',
        '1 pending'
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.pendingCount',
        '{{value0}} pending',
        { value0: count }
      )
}
