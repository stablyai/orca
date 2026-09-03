import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  defaultRangeExtractor,
  measureElement as measureVirtualElementSize,
  observeElementRect,
  useVirtualizer,
  type Range
} from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ActivityThreadListToolbar } from './activity-thread-list-toolbar'
import {
  getActiveStickyHeaderIndex,
  getActiveStickyHeaderIndexForScroll,
  getPreviousStickyHeaderIndex
} from '../sidebar/worktree-list/viewport/virtual-rows'
import { ActivityThreadVirtualRow } from './activity-thread-virtual-row'
import { ActivityThreadListResizeHandle } from './activity-thread-list-resize-handle'
import {
  buildActivityVirtualItems,
  estimateActivityVirtualItemSize,
  findActivityThreadItemIndex,
  getActivityHeaderItemIndexes,
  getActivityVirtualItemKey
} from './activity-thread-virtual-items'
import { ActivityThreadCollapseContext } from './activity-thread-collapse-context'
import type {
  ActivityGroupBy,
  ActivityThreadGroup,
  AgentPaneThread,
  ThreadReadFilter
} from './activity-thread-types'

const ZERO_RECT_FALLBACK_VIEWPORT = { width: 320, height: 600 }
const observeActivityListRect: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (rect) => {
    cb(rect.height > 0 ? rect : ZERO_RECT_FALLBACK_VIEWPORT)
  })

// A saved offset the content cannot contain yet is restored once it can; past
// this window it is stale (the list shrank) and restoring would yank the viewport.
const DEFERRED_SCROLL_RESTORE_WINDOW_MS = 3000

export function ActivityThreadListPane({
  threadListRef,
  threadListWidth,
  activityFilterInputRef,
  query,
  onQueryChange,
  groupBy,
  onGroupByChange,
  readFilter,
  onReadFilterChange,
  compactMode,
  showChildAgents,
  hasUnreadThreads,
  onCompactModeChange,
  onShowChildAgentsChange,
  onMarkAllThreadsRead,
  hasCompletedThreads,
  onClearCompleted,
  visibleThreadGroups,
  visibleThreadCount,
  selectedPaneKey,
  onSelectThread,
  onJumpToWorkspace,
  onMarkThreadRead,
  onMarkThreadUnread,
  canJumpToWorkspace,
  allowMarkUnreadWhenSelected = false,
  showJumpAction = true,
  isThreadListResizing,
  onResizeStart,
  showFilterControls = true,
  showOptionsMenu = true,
  showInlineActions = true,
  scopeFilterRow,
  collapsedGroupKeys,
  onToggleGroupCollapse,
  scrollTopRef
}: {
  threadListRef?: React.RefObject<HTMLDivElement | null>
  threadListWidth?: number
  activityFilterInputRef: React.RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  groupBy: ActivityGroupBy
  onGroupByChange: (groupBy: ActivityGroupBy) => void
  readFilter: ThreadReadFilter
  onReadFilterChange: (readFilter: ThreadReadFilter) => void
  compactMode: boolean
  showChildAgents?: boolean
  hasUnreadThreads: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onShowChildAgentsChange?: (showChildAgents: boolean) => void
  onMarkAllThreadsRead?: () => void
  hasCompletedThreads?: boolean
  onClearCompleted?: () => void
  visibleThreadGroups: ActivityThreadGroup[]
  visibleThreadCount: number
  selectedPaneKey: string | null
  onSelectThread: (thread: AgentPaneThread) => void
  onJumpToWorkspace: (thread: AgentPaneThread) => void
  onMarkThreadRead: (thread: AgentPaneThread) => void
  onMarkThreadUnread: (thread: AgentPaneThread) => void
  canJumpToWorkspace: (thread: AgentPaneThread) => boolean
  allowMarkUnreadWhenSelected?: boolean
  showJumpAction?: boolean
  isThreadListResizing?: boolean
  onResizeStart?: React.MouseEventHandler<HTMLDivElement>
  showFilterControls?: boolean
  showOptionsMenu?: boolean
  showInlineActions?: boolean
  /** Rendered between the toolbar and the list; carries the active-scope chips row. */
  scopeFilterRow?: React.ReactNode
  collapsedGroupKeys?: ReadonlySet<string>
  onToggleGroupCollapse?: (groupKey: string) => void
  /** Optional view-local scroll memory; updated without triggering React renders. */
  scrollTopRef?: React.MutableRefObject<number>
}): React.JSX.Element {
  const [internalCollapsedGroupKeys, setInternalCollapsedGroupKeys] = useState<Set<string>>(
    () => new Set()
  )
  // Precedence: explicit props, then a caller-owned context (hosts that unmount
  // the pane on body switches), then pane-local state.
  const contextCollapse = useContext(ActivityThreadCollapseContext)
  const isControlled = collapsedGroupKeys !== undefined && onToggleGroupCollapse !== undefined
  const effectiveCollapsedGroupKeys = isControlled
    ? collapsedGroupKeys
    : (contextCollapse?.collapsedGroupKeys ?? internalCollapsedGroupKeys)
  const handleToggleGroup = isControlled
    ? onToggleGroupCollapse
    : (contextCollapse?.onToggleGroupCollapse ??
      ((groupKey: string) => {
        setInternalCollapsedGroupKeys((prev) => {
          const next = new Set(prev)
          if (next.has(groupKey)) {
            next.delete(groupKey)
          } else {
            next.add(groupKey)
          }
          return next
        })
      }))

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const hasRestoredScrollRef = useRef(false)
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!scrollTopRef) {
        return
      }
      const scrollTop = event.currentTarget.scrollTop
      // A clamp-to-0 fired before the deferred restore must not wipe the saved offset.
      if (!hasRestoredScrollRef.current) {
        if (scrollTop === 0) {
          return
        }
        hasRestoredScrollRef.current = true
      }
      scrollTopRef.current = scrollTop
    },
    [scrollTopRef]
  )
  const virtualItems = useMemo(
    () =>
      buildActivityVirtualItems({
        groups: visibleThreadGroups,
        groupBy,
        collapsedGroupKeys: effectiveCollapsedGroupKeys
      }),
    [visibleThreadGroups, groupBy, effectiveCollapsedGroupKeys]
  )
  const headerItemIndexes = useMemo(
    () => getActivityHeaderItemIndexes(virtualItems),
    [virtualItems]
  )
  const selectedItemIndex = useMemo(
    () => findActivityThreadItemIndex(virtualItems, selectedPaneKey),
    [virtualItems, selectedPaneKey]
  )

  // Why keyed on virtualItems: getItemKey identity is a measurement-memo input in tanstack
  // virtual. A per-render closure recomputes every row on unrelated re-renders; a fully stable
  // one would miss same-count reorders. Changing exactly with the items is the correct middle.
  const getItemKey = useCallback(
    (index: number) => {
      const item = virtualItems[index]
      return item ? getActivityVirtualItemKey(item) : `__stale_${index}`
    },
    [virtualItems]
  )
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => estimateActivityVirtualItemSize(virtualItems[index], compactMode),
    getItemKey,
    measureElement: (element, entry, instance) => {
      const measured = measureVirtualElementSize(element, entry, instance)
      if (measured > 0) {
        return measured
      }
      const index = Number.parseInt(element.getAttribute('data-index') ?? '', 10)
      return estimateActivityVirtualItemSize(
        Number.isNaN(index) ? undefined : virtualItems[index],
        compactMode
      )
    },
    rangeExtractor: useCallback(
      (range: Range) => {
        const activeStickyIndex =
          groupBy !== 'none'
            ? getActiveStickyHeaderIndex(headerItemIndexes, range.startIndex)
            : null
        const previousStickyIndex =
          activeStickyIndex !== null
            ? getPreviousStickyHeaderIndex(headerItemIndexes, activeStickyIndex)
            : null
        const indexSet = new Set(defaultRangeExtractor(range))
        if (activeStickyIndex !== null) {
          indexSet.add(activeStickyIndex)
        }
        if (previousStickyIndex !== null) {
          indexSet.add(previousStickyIndex)
        }
        if (selectedItemIndex !== null && selectedItemIndex >= 0) {
          indexSet.add(selectedItemIndex)
        }
        return Array.from(indexSet).sort((a, b) => a - b)
      },
      [groupBy, headerItemIndexes, selectedItemIndex]
    ),
    overscan: 8,
    observeElementRect: observeActivityListRect,
    useFlushSync: false
  })

  // Row heights differ between densities; drop stale measurements on toggle (not on mount).
  const measuredCompactModeRef = useRef(compactMode)
  useEffect(() => {
    if (measuredCompactModeRef.current === compactMode) {
      return
    }
    measuredCompactModeRef.current = compactMode
    virtualizer.measure()
  }, [virtualizer, compactMode])

  // Restore only once the (estimated) content can contain the saved offset, so a
  // pre-hydration mount doesn't clamp the restore to 0.
  const totalSize = virtualizer.getTotalSize()
  const restoreArmedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (!scrollTopRef || hasRestoredScrollRef.current) {
      return
    }
    if (restoreArmedAtRef.current === null) {
      restoreArmedAtRef.current = Date.now()
    } else if (Date.now() - restoreArmedAtRef.current > DEFERRED_SCROLL_RESTORE_WINDOW_MS) {
      // The list stayed too small for the saved offset (it shrank); firing the
      // restore on some later growth would yank the viewport out from the user.
      hasRestoredScrollRef.current = true
      scrollTopRef.current = 0
      return
    }
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }
    // Against the max offset, not the content height: a viewport taller than the
    // remaining content clamps the assignment to 0 and burns the one restore.
    const maxScrollTop = Math.max(0, totalSize - scrollContainer.clientHeight)
    if (scrollTopRef.current > maxScrollTop) {
      return
    }
    scrollContainer.scrollTop = scrollTopRef.current
    hasRestoredScrollRef.current = true
  }, [scrollTopRef, totalSize])

  const scrollOffset = virtualizer.scrollOffset ?? 0
  const activeStickyHeaderIndex =
    groupBy !== 'none'
      ? getActiveStickyHeaderIndexForScroll({
          rangeStartIndex: virtualizer.range?.startIndex ?? 0,
          scrollOffset,
          stickyHeaderIndexes: headerItemIndexes,
          virtualItems: virtualizer.getVirtualItems()
        })
      : null

  const resizable = onResizeStart !== undefined
  return (
    <aside
      ref={threadListRef}
      className={cn(
        'relative flex min-h-0 flex-col',
        resizable ? 'shrink-0 border-r border-border' : 'min-w-0 flex-1'
      )}
      style={resizable ? { width: threadListWidth } : undefined}
    >
      <ActivityThreadListToolbar
        activityFilterInputRef={activityFilterInputRef}
        query={query}
        onQueryChange={onQueryChange}
        groupBy={groupBy}
        onGroupByChange={onGroupByChange}
        readFilter={readFilter}
        onReadFilterChange={onReadFilterChange}
        compactMode={compactMode}
        showChildAgents={showChildAgents}
        hasUnreadThreads={hasUnreadThreads}
        onCompactModeChange={onCompactModeChange}
        onShowChildAgentsChange={onShowChildAgentsChange}
        onMarkAllThreadsRead={onMarkAllThreadsRead}
        hasCompletedThreads={hasCompletedThreads}
        onClearCompleted={onClearCompleted}
        resizable={resizable}
        showFilterControls={showFilterControls}
        showOptionsMenu={showOptionsMenu}
        showInlineActions={showInlineActions}
      />
      {scopeFilterRow}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={scrollTopRef ? handleScroll : undefined}
          className="h-full overflow-y-auto overflow-x-hidden px-1.5 pb-1.5 pt-px scrollbar-sleek"
        >
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
            data-activity-virtual-list=""
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualItems[virtualRow.index]
              if (!item) {
                return null
              }
              const isActiveSticky =
                item.type === 'header' && virtualRow.index === activeStickyHeaderIndex
              return (
                <div
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-activity-sticky-header={item.type === 'header' ? '' : undefined}
                  data-activity-sticky-header-active={isActiveSticky ? '' : undefined}
                  className={cn(
                    'left-0 right-0 w-full',
                    isActiveSticky
                      ? cn(
                          'sticky -top-px z-20',
                          resizable ? 'bg-background' : 'bg-worktree-sidebar'
                        )
                      : 'absolute top-0'
                  )}
                  style={
                    isActiveSticky ? undefined : { transform: `translateY(${virtualRow.start}px)` }
                  }
                >
                  <ActivityThreadVirtualRow
                    item={item}
                    collapsed={
                      item.type === 'header' && effectiveCollapsedGroupKeys.has(item.group.key)
                    }
                    onToggleGroup={handleToggleGroup}
                    selectedPaneKey={selectedPaneKey}
                    onSelectThread={onSelectThread}
                    onJumpToWorkspace={onJumpToWorkspace}
                    onMarkThreadRead={onMarkThreadRead}
                    onMarkThreadUnread={onMarkThreadUnread}
                    canJumpToWorkspace={canJumpToWorkspace}
                    compactMode={compactMode}
                    allowMarkUnreadWhenSelected={allowMarkUnreadWhenSelected}
                    showJumpAction={showJumpAction}
                  />
                </div>
              )
            })}
          </div>
          {visibleThreadCount === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.activity.ActivityPrototypePage.7cd632006b',
                'No agent activity matches these filters.'
              )}
            </div>
          ) : null}
        </div>
      </div>
      {resizable ? (
        <ActivityThreadListResizeHandle
          isResizing={isThreadListResizing}
          onResizeStart={onResizeStart}
        />
      ) : null}
    </aside>
  )
}
