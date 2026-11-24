import { useVirtualizer } from '@tanstack/react-virtual'
import { GitGraphOpenButton } from './git-graph-open-button'
import { CommitsHeaderIconButton } from './commits-header-icon-button'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleHelp, RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import type {
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../../shared/git/history/git-history-types'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels
} from '../../../../../../shared/git/history/git-history-graph'
import { GitHistoryRow } from './git-history-row'
import { GitHistoryCommitFiles, type GitHistoryCommitFilesState } from './git-history-commit-files'
import {
  GitHistoryCommitContextMenu,
  type GitHistoryCommitAction
} from './git-history-commit-context-menu'
import type { SourceControlRowOpenEvent } from '../listing/split-open'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useGitGraphScope } from '@/lib/source-control/graph/git-graph-tab'
import { useGitGraphWorkspaces } from '@/components/editor/git-graph/git-graph-ref-menu'

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

export function GitHistoryPanel({
  state,
  worktreeId,
  collapsed,
  onToggle,
  onRefresh,
  onOpenCommit,
  onLoadCommitFiles,
  onOpenCommitFile,
  onCommitAction,
  onOpenGitGraph
}: {
  worktreeId?: string
  state: GitHistoryPanelState
  collapsed: boolean
  onToggle: () => void
  onRefresh: () => void
  onOpenCommit?: (item: GitHistoryItem) => void
  onLoadCommitFiles?: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
  onOpenCommitFile?: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: SourceControlRowOpenEvent
  ) => void
  onCommitAction?: (action: GitHistoryCommitAction, item: GitHistoryItem) => void
  onOpenGitGraph?: (event: SourceControlRowOpenEvent) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const result = state.result
  const agentWorkspaces = useGitGraphWorkspaces(useGitGraphScope(worktreeId ?? ''), true)
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

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filesByCommit, setFilesByCommit] = useState<Record<string, GitHistoryCommitFilesState>>({})
  const loadedCommitsRef = useRef(new Set<string>())
  const [previousResult, setPreviousResult] = useState(result)
  if (result !== previousResult) {
    setPreviousResult(result)
    const ids = new Set(result?.items.map((item) => item.id))
    setExpanded(new Set([...expanded].filter((id) => ids.has(id))))
    setFilesByCommit(
      Object.fromEntries(Object.entries(filesByCommit).filter(([id]) => ids.has(id)))
    )
  }
  useEffect(() => {
    const ids = new Set(result?.items.map((item) => item.id))
    loadedCommitsRef.current = new Set([...loadedCommitsRef.current].filter((id) => ids.has(id)))
  }, [result])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: collapsed ? 0 : viewModels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 8,
    getItemKey: (index) => `${viewModels[index]!.kind}:${viewModels[index]!.historyItem.id}`
  })

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
          aria-label={t(
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
            <span>{t('auto.components.right.sidebar.GitHistoryPanel.d836037d02', 'Commits')}</span>
            {result && <span className="text-[10px] font-medium tabular-nums">{count}</span>}
            {result?.hasMore && <span className="text-[10px] font-medium">+</span>}
          </button>
          {worktreeId && <GitGraphOpenButton worktreeId={worktreeId} onOpen={onOpenGitGraph} />}
          <Tooltip>
            <TooltipTrigger asChild>
              <CommitsHeaderIconButton
                aria-label={t(
                  'auto.components.right.sidebar.GitHistoryPanel.9289ba0cb9',
                  'What are refs?'
                )}
                onClick={(event) => {
                  event.stopPropagation()
                }}
              >
                <CircleHelp className="size-3.5" />
              </CommitsHeaderIconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
              {t(
                'auto.components.right.sidebar.GitHistoryPanel.9f7535d22b',
                'Refs are branch or tag names pointing at that exact commit. They only appear where Git has a named ref for the commit.'
              )}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <CommitsHeaderIconButton
                onClick={(event) => {
                  event.stopPropagation()
                  if (collapsed) {
                    onToggle()
                    return
                  }
                  onRefresh()
                }}
                aria-label={t(
                  'auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2',
                  'Refresh commits'
                )}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </CommitsHeaderIconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2', 'Refresh commits')}
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
        <div className={expandedBodyClassName} style={expandedBodyStyle} />
      )}
      {!collapsed && result && viewModels.length === 0 && (
        <div
          className={cn(expandedBodyClassName, 'px-6 py-2 text-[11px] text-muted-foreground')}
          style={expandedBodyStyle}
        >
          {t('auto.components.right.sidebar.GitHistoryPanel.cf7cad58d2', 'No commits yet')}
        </div>
      )}
      {!collapsed && viewModels.length > 0 && (
        <div ref={scrollRef} className={expandedBodyClassName} style={expandedBodyStyle}>
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const viewModel = viewModels[virtualRow.index]!
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
                  agentWorkspaces={agentWorkspaces}
                  onOpenCommit={onOpenCommit}
                  onToggleExpand={canExpand ? handleToggleExpand : undefined}
                />
              )
              return (
                <div
                  key={`${viewModel.kind}:${item.id}`}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
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
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
