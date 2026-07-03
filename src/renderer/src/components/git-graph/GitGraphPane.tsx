import React, { useCallback, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Network, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels
} from '../../../../shared/git-history-graph'
import { GitHistoryRow } from '../right-sidebar/GitHistoryRow'
import { useGitHistoryCommitActions } from '../right-sidebar/useGitHistoryCommitActions'
import { translate } from '@/i18n/i18n'
import { useGitGraphHistory } from './useGitGraphHistory'

// Why: each Git Graph row is a fixed-height GitHistoryRow (min-h-[26px]); a
// constant estimate keeps the virtualizer cheap for up to 200 rows.
const GIT_GRAPH_ROW_HEIGHT = 28
const GIT_GRAPH_ROW_OVERSCAN = 12

function GitGraphPane({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const { state, refresh, context } = useGitGraphHistory(worktreeId)
  const result = state.result
  const loading = state.status === 'loading' || state.status === 'refreshing'

  const viewModels = useMemo(() => {
    if (!result) {
      return []
    }
    // All-refs mode has no incoming/outgoing or remote/base refs (the loader
    // forks before computing them), so pass currentRef only.
    return buildGitHistoryViewModels(
      result.items,
      buildDefaultGitHistoryColorMap(result),
      result.currentRef,
      undefined,
      undefined
    )
  }, [result])

  // Full-pane tab opens commits in its own group; no split target to resolve.
  const noSplitTarget = useCallback(() => undefined, [])
  const { openHistoryCommitDiff } = useGitHistoryCommitActions({
    activeWorktreeId: worktreeId,
    worktreePath: context?.worktreePath ?? null,
    activeRepoSettings: context?.settings,
    resolveSplitTargetGroupId: noSplitTarget
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: viewModels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GIT_GRAPH_ROW_HEIGHT,
    overscan: GIT_GRAPH_ROW_OVERSCAN,
    getItemKey: (index) => viewModels[index]?.historyItem.id ?? `missing:${index}`
  })

  const count = result?.items.length ?? 0
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Network className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-semibold">
          {translate('auto.components.git.graph.GitGraphPane.6f0a2d1b84', 'Git Graph')}
        </span>
        {result && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
        <div className="ml-auto flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={refresh}
                aria-label={translate(
                  'auto.components.git.graph.GitGraphPane.b71e9c4d22',
                  'Refresh graph'
                )}
              >
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.git.graph.GitGraphPane.b71e9c4d22', 'Refresh graph')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {result?.hasMore && (
        <div className="shrink-0 border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.git.graph.GitGraphPane.9a3f5c2e70',
            'Showing first {{value0}} commits across all branches',
            { value0: result.limit }
          )}
        </div>
      )}

      {state.status === 'error' && !result ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-sm text-destructive">
          <span className="text-center">{state.error}</span>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            {translate('auto.components.git.graph.GitGraphPane.5d2e9b7a14', 'Retry')}
          </Button>
        </div>
      ) : (state.status === 'idle' || state.status === 'loading') && !result ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          <span>
            {translate('auto.components.git.graph.GitGraphPane.2c8b1f0a93', 'Loading graph...')}
          </span>
        </div>
      ) : viewModels.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {translate('auto.components.git.graph.GitGraphPane.4e7d6a1c08', 'No commits yet')}
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualRow) => {
              const viewModel = viewModels[virtualRow.index]
              if (!viewModel) {
                return null
              }
              return (
                <div
                  key={virtualRow.key}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <GitHistoryRow
                    viewModel={viewModel}
                    layout="pane"
                    onOpenCommit={(item) => void openHistoryCommitDiff(item)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default React.memo(GitGraphPane)
