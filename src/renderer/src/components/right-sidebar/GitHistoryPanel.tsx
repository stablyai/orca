import React, { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleHelp, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import type { GitHistoryItem, GitHistoryResult } from '../../../../shared/git-history'
import type { GitBranchChangeEntry, SourceControlViewMode } from '../../../../shared/types'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels
} from '../../../../shared/git-history-graph'
import { GitHistoryRow } from './GitHistoryRow'
import { GitHistoryCommitFilesRowView } from './GitHistoryCommitFiles'
import { GitHistoryPanelOverflowMenu } from './git-history-panel-overflow-menu'
import { useGitHistoryCommitFiles } from './use-git-history-commit-files'
import { GitHistoryRefreshError } from './GitHistoryRefreshError'
import {
  GitHistoryCommitContextMenu,
  type GitHistoryCommitAction
} from './GitHistoryCommitContextMenu'
import type { SourceControlRowOpenEvent } from './source-control-split-open'
import { SourceControlVirtualFileList } from './source-control-virtual-file-list'
import {
  buildGitHistoryVirtualRows,
  estimateGitHistoryVirtualRowHeight,
  getGitHistoryVirtualRowKey,
  type GitHistoryVirtualRow
} from './git-history-virtual-rows'
import {
  MAX_GIT_HISTORY_PANEL_HEIGHT,
  MIN_GIT_HISTORY_PANEL_HEIGHT,
  useGitHistoryPanelResize
} from './use-git-history-panel-resize'
import { translate } from '@/i18n/i18n'

export type GitHistoryPanelState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

const MAX_GIT_HISTORY_PANEL_VIEWPORT_HEIGHT = '33vh'
const EMPTY_EXPANDED_COMMIT_IDS: ReadonlySet<string> = new Set()

export function GitHistoryPanel({
  state,
  collapsed,
  onToggle,
  onRefresh,
  onOpenCommit,
  onLoadCommitFiles,
  onOpenCommitFile,
  onCommitAction,
  commitFilesViewMode,
  onCommitFilesViewModeChange
}: {
  state: GitHistoryPanelState
  collapsed: boolean
  onToggle: () => void
  onRefresh: () => void | Promise<void>
  onOpenCommit?: (item: GitHistoryItem) => void
  onLoadCommitFiles?: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
  onOpenCommitFile?: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: SourceControlRowOpenEvent
  ) => void
  onCommitAction?: (action: GitHistoryCommitAction, item: GitHistoryItem) => void
  commitFilesViewMode: SourceControlViewMode
  onCommitFilesViewModeChange?: (viewMode: SourceControlViewMode) => void
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
  const { panelHeight, onResizePointerDown, onResizeKeyDown } = useGitHistoryPanelResize(collapsed)
  const [refreshPending, setRefreshPending] = useState(false)
  const refreshPendingRef = useRef(false)
  const refreshBlocked = loading || refreshPending

  const {
    expanded,
    filesByCommit,
    collapsedCommitTreeDirs,
    handleToggleExpand,
    handleToggleCommitTreeDirectory
  } = useGitHistoryCommitFiles({ result, onLoadCommitFiles })
  const canExpandCommitFiles = Boolean(onLoadCommitFiles) && Boolean(onOpenCommitFile)
  const [historyScrollElement, setHistoryScrollElement] = useState<HTMLDivElement | null>(null)
  const historyRows = useMemo(
    () =>
      buildGitHistoryVirtualRows({
        viewModels,
        expandedCommitIds: canExpandCommitFiles ? expanded : EMPTY_EXPANDED_COMMIT_IDS,
        filesByCommit,
        viewMode: commitFilesViewMode,
        collapsedTreeDirs: collapsedCommitTreeDirs,
        canOpenAll: Boolean(onOpenCommit)
      }),
    [
      canExpandCommitFiles,
      collapsedCommitTreeDirs,
      commitFilesViewMode,
      expanded,
      filesByCommit,
      onOpenCommit,
      viewModels
    ]
  )
  const preserveRefIds = useMemo(
    () => (result?.baseRef ? [result.baseRef.id] : undefined),
    [result?.baseRef]
  )

  const handleRefresh = useCallback((): void => {
    if (loading || refreshPendingRef.current) {
      return
    }
    refreshPendingRef.current = true
    setRefreshPending(true)
    const releaseRefresh = (): void => {
      refreshPendingRef.current = false
      setRefreshPending(false)
    }
    try {
      void Promise.resolve(onRefresh()).then(releaseRefresh, releaseRefresh)
    } catch (error) {
      releaseRefresh()
      throw error
    }
  }, [loading, onRefresh])

  const expandedBodyClassName = 'overflow-y-auto scrollbar-sleek'
  const expandedBodyStyle = {
    height: `min(${panelHeight}px, ${MAX_GIT_HISTORY_PANEL_VIEWPORT_HEIGHT})`
  }

  const renderHistoryVirtualRow = (virtualRow: GitHistoryVirtualRow): React.JSX.Element => {
    const item = virtualRow.viewModel.historyItem
    const rowKey = getGitHistoryVirtualRowKey(virtualRow)
    if (virtualRow.kind === 'detail') {
      return (
        <GitHistoryCommitFilesRowView
          key={rowKey}
          row={virtualRow.detail}
          onToggleTreeDirectory={handleToggleCommitTreeDirectory}
          onOpenFile={(entry, event) => onOpenCommitFile?.(item, entry, event)}
          onOpenAll={onOpenCommit ? () => onOpenCommit(item) : undefined}
        />
      )
    }

    const isBoundaryNode =
      virtualRow.viewModel.kind === 'incoming-changes' ||
      virtualRow.viewModel.kind === 'outgoing-changes'
    const canExpand = !isBoundaryNode && canExpandCommitFiles
    const row = (
      <GitHistoryRow
        key={rowKey}
        viewModel={virtualRow.viewModel}
        expanded={canExpand && expanded.has(item.id)}
        preserveRefIds={preserveRefIds}
        onOpenCommit={onOpenCommit}
        onToggleExpand={canExpand ? handleToggleExpand : undefined}
        data-commit-id={item.id}
      />
    )
    if (!onCommitAction || isBoundaryNode) {
      return row
    }
    return (
      <ContextMenu key={rowKey}>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <GitHistoryCommitContextMenu item={item} onAction={onCommitAction} />
      </ContextMenu>
    )
  }

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
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
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
                className="my-auto h-auto w-auto p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent [&_svg]:size-3"
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
          <GitHistoryPanelOverflowMenu
            commitFilesViewMode={commitFilesViewMode}
            viewModeToggleDisabled={!onCommitFilesViewModeChange}
            onToggleViewMode={() =>
              onCommitFilesViewModeChange?.(commitFilesViewMode === 'list' ? 'tree' : 'list')
            }
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-disabled={!collapsed && refreshBlocked ? true : undefined}
                className={cn(
                  'my-auto h-auto w-auto p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent [&_svg]:size-3',
                  !collapsed && refreshBlocked && 'cursor-not-allowed opacity-50'
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  if (collapsed) {
                    onToggle()
                    return
                  }
                  handleRefresh()
                }}
                aria-label={translate(
                  'auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2',
                  'Refresh commits'
                )}
              >
                <RefreshCw className={cn('size-3.5', refreshBlocked && 'animate-spin')} />
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
        <div className={expandedBodyClassName} style={expandedBodyStyle}>
          <GitHistoryRefreshError
            error={state.error}
            pending={refreshBlocked}
            onRetry={handleRefresh}
          />
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
        <div className={expandedBodyClassName} style={expandedBodyStyle}>
          {state.status === 'error' && (
            <GitHistoryRefreshError
              error={state.error}
              pending={refreshBlocked}
              onRetry={handleRefresh}
            />
          )}
          <div className="px-6 py-2 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.GitHistoryPanel.cf7cad58d2',
              'No commits yet'
            )}
          </div>
        </div>
      )}
      {!collapsed && viewModels.length > 0 && (
        <div
          ref={setHistoryScrollElement}
          className={expandedBodyClassName}
          style={expandedBodyStyle}
        >
          {state.status === 'error' && (
            <GitHistoryRefreshError
              error={state.error}
              pending={refreshBlocked}
              onRetry={handleRefresh}
            />
          )}
          <SourceControlVirtualFileList
            rows={historyRows}
            scrollElement={historyScrollElement}
            getRowKey={getGitHistoryVirtualRowKey}
            estimateRowHeight={estimateGitHistoryVirtualRowHeight}
            renderRow={renderHistoryVirtualRow}
          />
        </div>
      )}
    </div>
  )
}
