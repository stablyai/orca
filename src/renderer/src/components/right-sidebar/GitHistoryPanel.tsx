import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleHelp, RefreshCw } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'

export type GitHistoryPanelState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

const DEFAULT_GIT_HISTORY_PANEL_HEIGHT = 256
const MIN_GIT_HISTORY_PANEL_HEIGHT = 96
const MAX_GIT_HISTORY_PANEL_HEIGHT = 520
const MAX_GIT_HISTORY_PANEL_VIEWPORT_HEIGHT = '33vh'

type GitHistoryResizeSession = {
  startY: number
  startHeight: number
  previousCursor: string
  previousUserSelect: string
}

function clampGitHistoryPanelHeight(height: number): number {
  return Math.min(MAX_GIT_HISTORY_PANEL_HEIGHT, Math.max(MIN_GIT_HISTORY_PANEL_HEIGHT, height))
}

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
  const refLabel = itemRef.category ? `${itemRef.name} (${itemRef.category})` : itemRef.name

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="max-w-[8rem] truncate rounded-full border bg-sidebar px-1.5 py-0.5 text-[10px] leading-none"
          style={{
            borderColor: itemRef.color ? graphColor(itemRef.color) : 'var(--border)',
            color: itemRef.color ? graphColor(itemRef.color) : 'var(--muted-foreground)'
          }}
          title={itemRef.name}
        >
          {itemRef.name}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        {refLabel}
      </TooltipContent>
    </Tooltip>
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
  const refs = item.references ?? []
  const visibleRefs = refs.slice(0, 2)
  const hiddenRefs = refs.slice(2)
  const rowTooltip = item.message || item.subject
  const rowClassName = cn(
    'grid min-h-[34px] w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_4.5rem_3.25rem_3.75rem] grid-rows-[auto_auto] items-start gap-x-1.5 px-3 py-1 text-left text-xs transition-colors',
    canOpenCommit && 'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40',
    !canOpenCommit && 'cursor-default',
    isBoundaryNode && 'text-muted-foreground'
  )
  const rowContent = (
    <>
      <div className="row-span-2">
        <GitHistoryGraphSvg viewModel={viewModel} />
      </div>
      <div className="min-w-0 overflow-hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block min-w-0 truncate text-foreground" title={rowTooltip}>
              {item.subject}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="max-w-96 whitespace-pre-wrap">
            {rowTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      {item.author ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="min-w-0 truncate text-right text-[11px] leading-4 text-muted-foreground"
              title={item.author}
            >
              {item.author}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-all">
            {item.author}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="min-w-0 truncate text-right text-[11px] leading-4 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate text-right text-[11px] leading-4 text-muted-foreground">
        {timestamp}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-[10px] leading-4 text-muted-foreground">
        {!isBoundaryNode ? item.displayId : ''}
      </span>
      <div className="col-span-4 col-start-2 min-w-0 overflow-hidden">
        {refs.length > 0 && (
          <div className="mt-0.5 flex h-3.5 min-w-0 items-center gap-1 overflow-hidden">
            {visibleRefs.map((ref) => (
              <GitHistoryRefBadge key={ref.id} itemRef={ref} />
            ))}
            {hiddenRefs.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="shrink-0 text-[10px] leading-none text-muted-foreground"
                    title={hiddenRefs.map((ref) => ref.name).join(', ')}
                  >
                    +{hiddenRefs.length}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
                  {hiddenRefs.map((ref) => ref.name).join(', ')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </>
  )

  if (!canOpenCommit) {
    return (
      <div className={rowClassName} title={rowTooltip} data-testid="git-history-row">
        {rowContent}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={rowClassName}
      title={rowTooltip}
      aria-label={translate("auto.components.right.sidebar.GitHistoryPanel.8232c8b2f2", "Open commit {{value0}}: {{value1}}", { value0: item.displayId ?? item.id, value1: item.subject })}
      data-testid="git-history-row"
      onClick={() => {
        onOpenCommit?.(item)
      }}
    >
      {rowContent}
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
  const [panelHeight, setPanelHeight] = useState(DEFAULT_GIT_HISTORY_PANEL_HEIGHT)
  const resizeSessionRef = useRef<GitHistoryResizeSession | null>(null)

  const stopResize = useCallback((): void => {
    const session = resizeSessionRef.current
    if (!session) {
      return
    }
    resizeSessionRef.current = null
    document.body.style.cursor = session.previousCursor
    document.body.style.userSelect = session.previousUserSelect
  }, [])

  const handleResizePointerMove = useCallback((event: PointerEvent): void => {
    const session = resizeSessionRef.current
    if (!session) {
      return
    }
    setPanelHeight(clampGitHistoryPanelHeight(session.startHeight + session.startY - event.clientY))
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', handleResizePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('pointermove', handleResizePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
      stopResize()
    }
  }, [handleResizePointerMove, stopResize])

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (collapsed) {
        return
      }
      event.preventDefault()
      resizeSessionRef.current = {
        startY: event.clientY,
        startHeight: panelHeight,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [collapsed, panelHeight]
  )

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 32 : 16
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setPanelHeight((height) => clampGitHistoryPanelHeight(height + step))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setPanelHeight((height) => clampGitHistoryPanelHeight(height - step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setPanelHeight(MIN_GIT_HISTORY_PANEL_HEIGHT)
    } else if (event.key === 'End') {
      event.preventDefault()
      setPanelHeight(MAX_GIT_HISTORY_PANEL_HEIGHT)
    }
  }, [])

  const expandedBodyClassName = 'overflow-y-auto scrollbar-sleek'
  const expandedBodyStyle = {
    height: `min(${panelHeight}px, ${MAX_GIT_HISTORY_PANEL_VIEWPORT_HEIGHT})`
  }

  return (
    <div className="relative">
      {!collapsed && (
        <div
          role="separator"
          aria-label={translate("auto.components.right.sidebar.GitHistoryPanel.e5e81e59a6", "Resize commits")}
          aria-orientation="horizontal"
          aria-valuemin={MIN_GIT_HISTORY_PANEL_HEIGHT}
          aria-valuemax={MAX_GIT_HISTORY_PANEL_HEIGHT}
          aria-valuenow={panelHeight}
          tabIndex={0}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize outline-none focus-visible:bg-ring/30"
          onPointerDown={startResize}
          onKeyDown={handleResizeKeyDown}
        />
      )}
      <div className="h-7 pl-1 pr-3">
        <div className="flex h-full items-stretch rounded-md pr-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 px-0.5 text-left text-[11px] font-semibold uppercase tracking-wider text-foreground/70"
            onClick={onToggle}
          >
            <ChevronDown
              className={cn('size-3 shrink-0 transition-transform', collapsed && '-rotate-90')}
            />
            <span>{translate("auto.components.right.sidebar.GitHistoryPanel.d836037d02", "Commits")}</span>
            {result && <span className="text-[10px] font-medium tabular-nums">{count}</span>}
            {result?.hasMore && <span className="text-[10px] font-medium">+</span>}
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="my-auto h-auto w-auto p-0.5 text-muted-foreground hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent [&_svg]:size-3"
                aria-label={translate("auto.components.right.sidebar.GitHistoryPanel.9289ba0cb9", "What are refs?")}
                onClick={(event) => {
                  event.stopPropagation()
                }}
              >
                <CircleHelp className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
              {translate("auto.components.right.sidebar.GitHistoryPanel.9f7535d22b", "Refs are branch or tag names pointing at that exact commit. They only appear where Git has a named ref for the commit.")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="my-auto h-auto w-auto p-0.5 text-muted-foreground hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent [&_svg]:size-3"
                onClick={(event) => {
                  event.stopPropagation()
                  if (collapsed) {
                    onToggle()
                    return
                  }
                  onRefresh()
                }}
                aria-label={translate("auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2", "Refresh commits")}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate("auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2", "Refresh commits")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {!collapsed && state.status === 'error' && !result && (
        <div
          className={cn(expandedBodyClassName, 'px-6 py-2 text-[11px] text-destructive')}
          style={expandedBodyStyle}
        >
          {state.error}
        </div>
      )}
      {!collapsed && (state.status === 'idle' || state.status === "loading") && !result && (
        <div
          className={cn(
            expandedBodyClassName,
            'flex items-start gap-2 px-6 py-2 text-[11px] text-muted-foreground'
          )}
          style={expandedBodyStyle}
        >
          <RefreshCw className="size-3 animate-spin" />
          <span>{translate("auto.components.right.sidebar.GitHistoryPanel.781a8bcf7b", "Loading graph...")}</span>
        </div>
      )}
      {!collapsed && result && viewModels.length === 0 && (
        <div
          className={cn(expandedBodyClassName, 'px-6 py-2 text-[11px] text-muted-foreground')}
          style={expandedBodyStyle}
        >
          {translate("auto.components.right.sidebar.GitHistoryPanel.cf7cad58d2", "No commits yet")}</div>
      )}
      {!collapsed && viewModels.length > 0 && (
        <div className={expandedBodyClassName} style={expandedBodyStyle}>
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
