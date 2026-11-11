import { useGitCommitActionsSupport } from '@/runtime/source-control/git/git-commit-actions-capability'
import {
  GitGraphCommitActionControls,
  GitGraphCommitConfirmStrip
} from './git-graph-commit-action-controls'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useVirtualizer } from '@tanstack/react-virtual'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { GitHistoryCommitContextMenu } from '@/components/right-sidebar/source-control/sync/git-history-commit-context-menu'
import { GitHistoryGraphSvg } from '@/components/right-sidebar/source-control/sync/git-history-graph-svg'
import { useGitHistoryCommitActions } from '@/components/right-sidebar/source-control/sync/use-git-history-commit-actions'
import { formatGitHistoryTimestamp } from '@/components/right-sidebar/source-control/sync/git-history-format'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels
} from '../../../../../shared/git/history/git-history-graph'
import { useGitGraphHistory, gitGraphFilterSupported } from './use-git-graph-history'
import { GitGraphFilter } from './git-graph-filter'
import { loadMoreInView } from './git-graph-viewport-paging'
import { GitGraphDetails } from './git-graph-details'
import { GitGraphRefs, useGitGraphWorkspaces } from './git-graph-ref-menu'
import { cn } from '@/lib/class-names'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

const sameGroup = () => undefined
// About 200px of rows, so scrolling fetches before the end shows.
const PAGE_AHEAD_ROWS = 8

export function GitGraphTab({ worktreeId }: { worktreeId: string }) {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const history = useGitGraphHistory(worktreeId)
  const { result, scope, selectedId, revealId, controller, loading } = history
  const commitActionSupport = useGitCommitActionsSupport(
    scope?.target ?? null,
    scope?.route.executionHostId ?? undefined
  )
  const workspaces = useGitGraphWorkspaces(scope)
  const rows = useMemo(
    () =>
      result
        ? buildGitHistoryViewModels(
            result.items,
            buildDefaultGitHistoryColorMap(result),
            result.currentRef
          )
        : [],
    [result]
  )
  const maxGraphWidth = useMemo(
    () =>
      rows.reduce(
        (width, row) =>
          Math.max(
            width,
            (Math.max(row.inputSwimlanes.length, row.outputSwimlanes.length) + 1) * 11
          ),
        132
      ),
    [rows]
  )
  const [graphWidth, setGraphWidth] = useState(controller.graphWidth)
  const [draftGraphWidth, setDraftGraphWidth] = useState(graphWidth)
  const commitGraphWidth = useCallback(
    (width: number) => {
      controller.graphWidth = width
      setGraphWidth(width)
    },
    [controller]
  )
  const { containerRef: graphHeader, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: graphWidth,
    minWidth: 44,
    maxWidth: maxGraphWidth,
    deltaSign: 1,
    setWidth: commitGraphWidth,
    onDraftWidthChange: setDraftGraphWidth
  })
  const columns = `160px ${draftGraphWidth}px minmax(200px,1fr) 120px 100px`
  const scroll = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    initialOffset: () => history.controller.scrollOffset,
    getScrollElement: () => scroll.current,
    estimateSize: () => 24,
    overscan: 12,
    getItemKey: (index) => rows[index]!.historyItem.id
  })
  const virtualItems = virtualizer.getVirtualItems()
  // Null while the pane has no height; read after getVirtualItems() recomputes it.
  const lastVisibleIndex = virtualizer.range?.endIndex ?? -1
  const endInView = lastVisibleIndex >= 0 && lastVisibleIndex >= rows.length - 1 - PAGE_AHEAD_ROWS
  useEffect(() => {
    // Viewport demand, not scroll events: page whenever the end of loaded rows is in view.
    if (endInView) {
      loadMoreInView(controller, result)
    }
  }, [endInView, result, loading, controller])
  const selected = result?.items.find((item) => item.id === selectedId)
  useLayoutEffect(() => {
    if (scroll.current) {
      scroll.current.scrollTop = controller.scrollOffset
    }
  }, [controller])
  useLayoutEffect(() => {
    if (!revealId) {
      return
    }
    const index = rows.findIndex((row) => row.historyItem.id === revealId)
    if (index !== -1) {
      virtualizer.scrollToIndex(index)
      controller.clearReveal()
    }
  }, [rows, revealId, virtualizer, controller])
  const actions = useGitHistoryCommitActions({
    activeWorktreeId: worktreeId,
    worktreePath: scope?.worktree.path ?? null,
    activeRepoTarget: scope?.target ?? null,
    ownerConnectionId: scope?.connectionId,
    resolveSplitTargetGroupId: sameGroup
  })
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <GitGraphFilter
          worktreeId={worktreeId}
          executionHostId={history.controller.executionHostId}
          filter={history.filter}
          supported={gitGraphFilterSupported(result)}
          onChange={history.changeFilter}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('gitGraph.refresh', 'Refresh commits')}
              onClick={() => void history.refresh()}
            >
              <RefreshCw className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('gitGraph.refresh', 'Refresh commits')}</TooltipContent>
        </Tooltip>
      </div>
      {history.error && (
        <div className="shrink-0 px-3 py-2 text-xs text-destructive">{history.error}</div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-x-auto scrollbar-sleek">
          <div
            className="grid h-7 shrink-0 items-center border-b border-border px-3 text-2xs text-muted-foreground"
            style={{ gridTemplateColumns: columns, minWidth: draftGraphWidth + 604 }}
          >
            <span>{t('gitGraph.branchTag', 'Branch / Tag')}</span>
            <div ref={graphHeader} className="relative flex h-full items-center">
              <span>{t('gitGraph.graph', 'Graph')}</span>
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={t('gitGraph.resizeColumn', 'Resize graph column')}
                aria-valuemin={44}
                aria-valuemax={maxGraphWidth}
                aria-valuenow={draftGraphWidth}
                className="absolute inset-y-0 right-0 w-2 cursor-col-resize hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onMouseDown={onResizeStart}
                onDoubleClick={() => commitGraphWidth(132)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    commitGraphWidth(
                      Math.max(
                        44,
                        Math.min(maxGraphWidth, graphWidth + (event.key === 'ArrowLeft' ? -11 : 11))
                      )
                    )
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    commitGraphWidth(132)
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    commitGraphWidth(maxGraphWidth)
                  }
                }}
              />
            </div>
            <span>{t('gitGraph.message', 'Message')}</span>
            <span>{t('gitGraph.author', 'Author')}</span>
            <span>{t('gitGraph.date', 'Date')}</span>
          </div>
          <div
            ref={scroll}
            className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
            onScroll={() => {
              const element = scroll.current
              if (element) {
                controller.scrollOffset = element.scrollTop
              }
            }}
          >
            <div
              className="relative min-w-max"
              style={{ height: virtualizer.getTotalSize(), minWidth: draftGraphWidth + 604 }}
            >
              {virtualItems.map((virtualRow) => {
                const viewModel = rows[virtualRow.index]!
                const item = viewModel.historyItem
                return (
                  <ContextMenu key={item.id}>
                    <ContextMenuTrigger asChild>
                      <div
                        className={cn(
                          'absolute left-0 top-0 grid h-6 w-full items-center px-3 text-xs hover:bg-accent',
                          selected?.id === item.id && 'bg-accent'
                        )}
                        style={{
                          transform: `translateY(${virtualRow.start}px)`,
                          gridTemplateColumns: columns
                        }}
                        data-current={selected?.id === item.id}
                        onClick={() => controller.select(item.id)}
                      >
                        <div className="flex min-w-0 gap-1 overflow-hidden pr-2">
                          <GitGraphRefs
                            controller={controller.actions}
                            support={commitActionSupport}
                            onCheckout={(ref) => controller.actions.requestBranch(item, ref)}
                            workspaces={workspaces}
                            references={item.references ?? []}
                            onSwitch={controller.switchToWorkspace}
                            currentRefId={result?.currentRef?.id}
                          />
                        </div>
                        <div className="min-w-0 overflow-hidden">
                          <GitHistoryGraphSvg viewModel={viewModel} />
                        </div>
                        <button
                          className="min-w-0 truncate pr-3 text-left"
                          title={item.message}
                          onClick={() => controller.select(item.id)}
                          onDoubleClick={() => void actions.openHistoryCommitDiff(item)}
                        >
                          {item.subject}
                        </button>
                        <span className="truncate pr-2 text-muted-foreground">{item.author}</span>
                        <span className="truncate text-2xs text-muted-foreground">
                          {formatGitHistoryTimestamp(item.timestamp, intlLocale)}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <GitHistoryCommitContextMenu item={item} onAction={actions.handleCommitAction}>
                      <GitGraphCommitActionControls
                        item={item}
                        controller={controller.actions}
                        support={commitActionSupport}
                        menu
                      />
                    </GitHistoryCommitContextMenu>
                  </ContextMenu>
                )
              })}
            </div>
            {result?.hasMore && (
              <Button
                className="m-2"
                variant="ghost"
                size="sm"
                disabled={history.loading}
                onClick={() => void history.loadMore()}
              >
                {t('gitGraph.loadMore', 'Load more')}
              </Button>
            )}
            {result && !result.items.length && (
              <div className="p-4 text-xs text-muted-foreground">
                {t('gitGraph.noCommits', 'No commits yet')}
              </div>
            )}
          </div>
        </div>
        <aside className="w-80 min-w-64 shrink-0 overflow-y-auto border-l border-border scrollbar-sleek">
          <GitGraphCommitConfirmStrip controller={controller.actions} />
          {selected && (
            <GitGraphDetails
              key={selected.id}
              item={selected}
              commitActions={
                <GitGraphCommitActionControls
                  item={selected}
                  controller={controller.actions}
                  support={commitActionSupport}
                />
              }
              actions={actions}
              onParent={(id) => void history.reveal(id)}
            />
          )}
        </aside>
      </div>
    </div>
  )
}
