import React, { useMemo } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { GitHistoryItem, GitHistoryResult } from '../../../../shared/git-history'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels,
  type GitHistoryItemViewModel
} from '../../../../shared/git-history-graph'
import { GitHistoryGraphSvg, graphColor } from './GitHistoryGraphSvg'

export type GitHistoryPanelState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

function formatHistoryTimestamp(timestamp: number | undefined): string {
  if (!timestamp) {
    return ''
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(timestamp)
  )
}

function GitHistoryRefBadge({
  itemRef
}: {
  itemRef: NonNullable<GitHistoryResult['currentRef']>
}): React.JSX.Element {
  return (
    <span
      className="max-w-[8rem] truncate rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
      style={{
        borderColor: itemRef.color ? graphColor(itemRef.color) : 'var(--border)',
        color: itemRef.color ? graphColor(itemRef.color) : 'var(--muted-foreground)'
      }}
      title={itemRef.name}
    >
      {itemRef.name}
    </span>
  )
}

function GitHistoryRow({
  viewModel,
  onOpenCommit
}: {
  viewModel: GitHistoryItemViewModel
  onOpenCommit?: (item: GitHistoryItem) => void
}): React.JSX.Element {
  const item = viewModel.historyItem
  const timestamp = formatHistoryTimestamp(item.timestamp)
  const isBoundaryNode =
    viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
  const canOpenCommit = !isBoundaryNode && Boolean(onOpenCommit)

  return (
    <button
      type="button"
      className={cn(
        'flex h-[22px] w-full min-w-0 items-center gap-1.5 px-3 text-left text-xs leading-none transition-colors disabled:cursor-default disabled:opacity-100',
        canOpenCommit && 'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40',
        isBoundaryNode && 'text-muted-foreground'
      )}
      title={item.message || item.subject}
      data-testid="git-history-row"
      disabled={!canOpenCommit}
      onClick={() => {
        if (canOpenCommit) {
          onOpenCommit?.(item)
        }
      }}
    >
      <GitHistoryGraphSvg viewModel={viewModel} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <span className="min-w-0 flex-1 truncate text-foreground">{item.subject}</span>
        {item.references?.map((ref) => (
          <GitHistoryRefBadge key={ref.id} itemRef={ref} />
        ))}
        {item.author && (
          <span className="max-w-[5.5rem] shrink truncate text-[11px] text-muted-foreground">
            {item.author}
          </span>
        )}
        {timestamp && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{timestamp}</span>
        )}
      </div>
      {item.displayId && !isBoundaryNode && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {item.displayId}
        </span>
      )}
    </button>
  )
}

export function GitHistoryPanel({
  state,
  collapsed,
  onToggle,
  onRefresh,
  onOpenCommit
}: {
  state: GitHistoryPanelState
  collapsed: boolean
  onToggle: () => void
  onRefresh: () => void
  onOpenCommit?: (item: GitHistoryItem) => void
}): React.JSX.Element | null {
  const result = state.result
  const viewModels = useMemo(() => {
    if (!result) {
      return []
    }
    return buildGitHistoryViewModels(
      result.items,
      buildDefaultGitHistoryColorMap(result),
      result.currentRef,
      result.remoteRef,
      result.baseRef,
      result.hasIncomingChanges,
      result.hasOutgoingChanges,
      result.mergeBase
    )
  }, [result])

  const loading = state.status === 'loading' || state.status === 'refreshing'
  const count = result?.items.length ?? 0

  if (!result && state.status === 'idle') {
    return null
  }

  return (
    <div>
      <div className="pl-1 pr-3 pt-3 pb-1">
        <div className="group/history flex items-center rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 px-0.5 py-0.5 text-left text-xs font-semibold uppercase tracking-wider text-foreground/70 group-hover/history:text-accent-foreground"
            onClick={onToggle}
          >
            <ChevronDown
              className={cn('size-3.5 shrink-0 transition-transform', collapsed && '-rotate-90')}
            />
            <span>Graph</span>
            <span className="text-[11px] font-medium tabular-nums">{count}</span>
            {result?.hasMore && <span className="text-[11px] font-medium">+</span>}
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="h-auto w-auto p-0.5 text-muted-foreground hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  onRefresh()
                }}
                aria-label="Refresh graph"
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Refresh graph
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {!collapsed && state.status === 'error' && !result && (
        <div className="px-6 py-2 text-[11px] text-destructive">{state.error}</div>
      )}
      {!collapsed && state.status === 'loading' && !result && (
        <div className="flex items-center gap-2 px-6 py-2 text-[11px] text-muted-foreground">
          <RefreshCw className="size-3 animate-spin" />
          <span>Loading graph...</span>
        </div>
      )}
      {!collapsed && result && viewModels.length === 0 && (
        <div className="px-6 py-2 text-[11px] text-muted-foreground">No commits yet</div>
      )}
      {!collapsed && viewModels.length > 0 && (
        <div className="max-h-[33vh] overflow-y-auto scrollbar-sleek">
          {viewModels.map((viewModel) => (
            <GitHistoryRow
              key={`${viewModel.kind}:${viewModel.historyItem.id}`}
              viewModel={viewModel}
              onOpenCommit={onOpenCommit}
            />
          ))}
        </div>
      )}
    </div>
  )
}
