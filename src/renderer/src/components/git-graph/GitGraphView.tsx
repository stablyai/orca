import React, { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { buildGitGraphRows } from '../../../../shared/git-graph-lane-layout'
import { GitHistoryCommitContextMenu } from '../right-sidebar/GitHistoryCommitContextMenu'
import { SWIMLANE_WIDTH } from '../right-sidebar/GitHistoryGraphSvg'
import { useGitHistoryCommitActions } from '../right-sidebar/useGitHistoryCommitActions'
import { GIT_GRAPH_ROW_HEIGHT, GitGraphRow } from './GitGraphRow'
import { buildGitGraphWorktreeOverlay } from './git-graph-worktree-overlay'
import { useGitGraphHistory } from './useGitGraphHistory'

const EMPTY_WORKTREES: never[] = []

// Whole-repo graph in the center pane: every branch, remote, and tag with
// Orca's worktree overlay on decorated branches.
export function GitGraphView({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const {
    state,
    remoteUnsupported,
    worktreePath,
    activeRepoSettings,
    refresh,
    loadMore,
    canLoadMore
  } = useGitGraphHistory(worktreeId)

  const repoId = useAppStore((s) => s.getKnownWorktreeById(worktreeId)?.repoId ?? null)
  const repoDisplayName = useAppStore((s) => {
    if (!repoId) {
      return null
    }
    return s.repos.find((candidate) => candidate.id === repoId)?.displayName ?? null
  })
  const repoWorktrees = useAppStore((s) =>
    repoId ? (s.worktreesByRepo[repoId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES
  )
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  const worktreeOverlay = useMemo(
    () => buildGitGraphWorktreeOverlay(repoWorktrees, activeWorktreeId),
    [activeWorktreeId, repoWorktrees]
  )

  const result = state.result
  const rows = useMemo(
    () => (result ? buildGitGraphRows(result.items, result.currentRef) : []),
    [result]
  )
  const laneColumnWidth = useMemo(() => {
    let maxLanes = 1
    for (const row of rows) {
      maxLanes = Math.max(maxLanes, row.inputSwimlanes.length, row.outputSwimlanes.length)
    }
    return SWIMLANE_WIDTH * (maxLanes + 1)
  }, [rows])

  const { openHistoryCommitDiff, handleCommitAction } = useGitHistoryCommitActions({
    activeWorktreeId: worktreeId,
    worktreePath,
    activeRepoSettings,
    resolveSplitTargetGroupId: () => undefined
  })

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GIT_GRAPH_ROW_HEIGHT,
    getItemKey: (index) => rows[index]!.historyItem.id,
    overscan: 20
  })

  const loading = state.status === 'loading' || state.status === 'refreshing'

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">
          {translate('auto.components.git.graph.GitGraphView.title', 'Git Graph')}
        </span>
        {repoDisplayName && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {repoDisplayName}
          </span>
        )}
        {result && (
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
            {result.items.length}
            {result.hasMore ? '+' : ''}
          </span>
        )}
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.git.graph.GitGraphView.refresh',
                'Refresh graph'
              )}
              onClick={refresh}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.git.graph.GitGraphView.refresh', 'Refresh graph')}
          </TooltipContent>
        </Tooltip>
      </div>

      {remoteUnsupported && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.git.graph.GitGraphView.remoteUnsupported',
            'The remote host runs an older Orca and returned current-branch history only. Update Orca on the host to see all branches.'
          )}
        </div>
      )}

      {state.status === 'error' && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-[11px] text-destructive">
          {state.error}
        </div>
      )}

      {(state.status === 'idle' || state.status === 'loading') && !result && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          <span>
            {translate('auto.components.git.graph.GitGraphView.loading', 'Loading graph...')}
          </span>
        </div>
      )}

      {result && rows.length === 0 && state.status !== 'loading' && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {translate('auto.components.git.graph.GitGraphView.empty', 'No commits yet')}
        </div>
      )}

      {rows.length > 0 && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const viewModel = rows[virtualRow.index]!
              return (
                <ContextMenu key={virtualRow.key}>
                  <ContextMenuTrigger asChild>
                    <GitGraphRow
                      viewModel={viewModel}
                      worktreeOverlay={worktreeOverlay}
                      laneColumnWidth={laneColumnWidth}
                      onOpenCommit={(item) => void openHistoryCommitDiff(item)}
                      className="absolute left-0 top-0"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    />
                  </ContextMenuTrigger>
                  <GitHistoryCommitContextMenu
                    item={viewModel.historyItem}
                    onAction={handleCommitAction}
                  />
                </ContextMenu>
              )
            })}
          </div>
          {canLoadMore && (
            <div className="flex justify-center py-2">
              <Button type="button" variant="ghost" size="sm" onClick={loadMore}>
                {translate('auto.components.git.graph.GitGraphView.loadMore', 'Load more commits')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
