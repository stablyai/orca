import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleHelp, Network, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import type { GitHistoryItem, GitHistoryResult } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/types'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels
} from '../../../../shared/git-history-graph'
import { GitHistoryRow } from './GitHistoryRow'
import { GitHistoryCommitFiles, type GitHistoryCommitFilesState } from './GitHistoryCommitFiles'
import {
  GitHistoryCommitContextMenu,
  type GitHistoryCommitAction
} from './GitHistoryCommitContextMenu'
import type { SourceControlRowOpenEvent } from './source-control-split-open'
import {
  MAX_GIT_HISTORY_PANEL_HEIGHT,
  MIN_GIT_HISTORY_PANEL_HEIGHT,
  useGitHistoryPanelResize
} from './useGitHistoryPanelResize'
import { translate } from '@/i18n/i18n'

export type GitHistoryPanelState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

export function GitHistoryPanel({
  state,
  collapsed,
  onToggle,
  onRefresh,
  onOpenGraph,
  onOpenCommit,
  onLoadCommitFiles,
  onOpenCommitFile,
  onCommitAction
}: {
  state: GitHistoryPanelState
  collapsed: boolean
  onToggle: () => void
  onRefresh: () => void
  // Opens the repo-wide Git Graph full-pane tab; Cmd/Ctrl-click splits.
  onOpenGraph?: (event: SourceControlRowOpenEvent) => void
  onOpenCommit?: (item: GitHistoryItem) => void
  onLoadCommitFiles?: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
  onOpenCommitFile?: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: SourceControlRowOpenEvent
  ) => void
  onCommitAction?: (action: GitHistoryCommitAction, item: GitHistoryItem) => void
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
  const { panelHeight, startResize, handleResizeKeyDown, expandedBodyStyle } =
    useGitHistoryPanelResize(collapsed)

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filesByCommit, setFilesByCommit] = useState<Record<string, GitHistoryCommitFilesState>>({})
  // Tracks commits whose files have been loaded (or are in flight) so re-expanding
  // never refetches; an entry is cleared on error to allow a retry.
  const loadedCommitsRef = useRef<Set<string>>(new Set())

  // A new history result can reorder or replace commits, so drop any expansion
  // and cached file lists rather than risk showing stale files under a row.
  useEffect(() => {
    setExpanded(new Set())
    setFilesByCommit({})
    loadedCommitsRef.current = new Set()
  }, [result])

  const handleToggleExpand = useCallback(
    (item: GitHistoryItem): void => {
      const id = item.id
      const willExpand = !expanded.has(id)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (willExpand) {
          next.add(id)
        } else {
          next.delete(id)
        }
        return next
      })
      if (!willExpand || !onLoadCommitFiles || loadedCommitsRef.current.has(id)) {
        return
      }
      loadedCommitsRef.current.add(id)
      setFilesByCommit((prev) => ({ ...prev, [id]: { status: 'loading' } }))
      onLoadCommitFiles(item)
        .then((entries) => {
          setFilesByCommit((prev) => ({ ...prev, [id]: { status: 'ready', entries } }))
        })
        .catch((error: unknown) => {
          loadedCommitsRef.current.delete(id)
          setFilesByCommit((prev) => ({
            ...prev,
            [id]: {
              status: 'error',
              error:
                error instanceof Error
                  ? error.message
                  : translate(
                      'auto.components.right.sidebar.GitHistoryPanel.6d1e0a7c3b',
                      'Failed to load commit files'
                    )
            }
          }))
        })
    },
    [expanded, onLoadCommitFiles]
  )

  const expandedBodyClassName = 'overflow-y-auto scrollbar-sleek'

  return (
    <div className="relative">
      {!collapsed && (
        <div
          role="separator"
          aria-label={translate(
            'auto.components.right.sidebar.GitHistoryPanel.e5e81e59a6',
            'Resize commits'
          )}
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
            <span>
              {translate('auto.components.right.sidebar.GitHistoryPanel.d836037d02', 'Commits')}
            </span>
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
                aria-label={translate(
                  'auto.components.right.sidebar.GitHistoryPanel.9289ba0cb9',
                  'What are refs?'
                )}
                onClick={(event) => {
                  event.stopPropagation()
                }}
              >
                <CircleHelp className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
              {translate(
                'auto.components.right.sidebar.GitHistoryPanel.9f7535d22b',
                'Refs are branch or tag names pointing at that exact commit. They only appear where Git has a named ref for the commit.'
              )}
            </TooltipContent>
          </Tooltip>
          {onOpenGraph && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="my-auto h-auto w-auto p-0.5 text-muted-foreground hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent [&_svg]:size-3"
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenGraph({
                      altKey: event.altKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      shiftKey: event.shiftKey
                    })
                  }}
                  aria-label={translate(
                    'auto.components.right.sidebar.GitHistoryPanel.4b8e2f1a06',
                    'Open Git Graph'
                  )}
                >
                  <Network className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate(
                  'auto.components.right.sidebar.GitHistoryPanel.4b8e2f1a06',
                  'Open Git Graph'
                )}
              </TooltipContent>
            </Tooltip>
          )}
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
                aria-label={translate(
                  'auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2',
                  'Refresh commits'
                )}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2',
                'Refresh commits'
              )}
            </TooltipContent>
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
      {!collapsed && (state.status === 'idle' || state.status === 'loading') && !result && (
        <div
          className={cn(
            expandedBodyClassName,
            'flex items-start gap-2 px-6 py-2 text-[11px] text-muted-foreground'
          )}
          style={expandedBodyStyle}
        >
          <RefreshCw className="size-3 animate-spin" />
          <span>
            {translate(
              'auto.components.right.sidebar.GitHistoryPanel.781a8bcf7b',
              'Loading graph...'
            )}
          </span>
        </div>
      )}
      {!collapsed && result && viewModels.length === 0 && (
        <div
          className={cn(expandedBodyClassName, 'px-6 py-2 text-[11px] text-muted-foreground')}
          style={expandedBodyStyle}
        >
          {translate('auto.components.right.sidebar.GitHistoryPanel.cf7cad58d2', 'No commits yet')}
        </div>
      )}
      {!collapsed && viewModels.length > 0 && (
        <div className={expandedBodyClassName} style={expandedBodyStyle}>
          {viewModels.map((viewModel) => {
            const item = viewModel.historyItem
            const isBoundaryNode =
              viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
            const canExpand =
              !isBoundaryNode && Boolean(onLoadCommitFiles) && Boolean(onOpenCommitFile)
            const isExpanded = canExpand && expanded.has(item.id)
            const row = (
              <GitHistoryRow
                viewModel={viewModel}
                expanded={isExpanded}
                preserveRefIds={result?.baseRef ? [result.baseRef.id] : undefined}
                onOpenCommit={onOpenCommit}
                onToggleExpand={canExpand ? handleToggleExpand : undefined}
              />
            )
            return (
              <React.Fragment key={`${viewModel.kind}:${item.id}`}>
                {onCommitAction && !isBoundaryNode ? (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                    <GitHistoryCommitContextMenu item={item} onAction={onCommitAction} />
                  </ContextMenu>
                ) : (
                  row
                )}
                {isExpanded && (
                  <GitHistoryCommitFiles
                    state={filesByCommit[item.id] ?? { status: 'loading' }}
                    author={item.author}
                    timestamp={item.timestamp}
                    onOpenFile={(entry, event) => onOpenCommitFile?.(item, entry, event)}
                    onOpenAll={onOpenCommit ? () => onOpenCommit(item) : undefined}
                  />
                )}
              </React.Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
