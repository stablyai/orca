import React, { useCallback, useMemo } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import type { TabBarProps } from '../tab-bar-props'
import { useTabBarModel } from '../model/use-tab-bar-model'
import { renderTabBarItems } from '../model/tab-bar-item-surface'
import { resolveRenderedTabStrip } from '../strip/rendered-tab-strip'
import { WindowedTabStrip } from '../strip/WindowedTabStrip'
import type { TabStripSegment } from '../strip/tab-strip-window'
import { TabStripTooltipProvider } from '../strip/TabStripTooltipProvider'
import { TabStripOrientationContext } from '../strip/tab-strip-orientation'
import ClientHostedBrowserTabRows from '../browser-tabs/ClientHostedBrowserTabRows'
import {
  VERTICAL_TAB_LIST_COLLAPSED_WIDTH,
  VERTICAL_TAB_LIST_DEFAULT_WIDTH,
  VERTICAL_TAB_LIST_MAX_WIDTH,
  VERTICAL_TAB_LIST_MIN_WIDTH
} from '../../../../../shared/workspace-layout/tab-strip-position'
import { countPinnedRows } from './vertical-tab-list-model'
import { useVerticalTabListScroller } from './use-vertical-tab-list-scroller'
import { VerticalTabListHeader } from './VerticalTabListHeader'
import { VerticalTabListResizeHandle } from './VerticalTabListResizeHandle'
import { TabStripPositionMenu } from './TabStripPositionMenu'

// Why half the row: a narrow split keeps room for its terminal, as the strip keeps its tab floor.
function measureMaxListWidth(list: HTMLElement): number {
  const rowWidth = list.parentElement?.clientWidth ?? 0
  return rowWidth > 0
    ? Math.max(VERTICAL_TAB_LIST_MIN_WIDTH, Math.min(VERTICAL_TAB_LIST_MAX_WIDTH, rowWidth / 2))
    : VERTICAL_TAB_LIST_MAX_WIDTH
}

/** Chrome-style vertical tabs: one row per tab in a resizable, collapsible list left of the split's body. */
function VerticalTabBar(props: TabBarProps): React.JSX.Element {
  const t = useTranslate()
  const { worktreeId } = props
  const model = useTabBarModel(props)
  const { runtime, itemProjection, itemActions, activeClientHostedBrowserRowId } = model
  const width = useAppStore((state) => state.verticalTabListWidth)
  const setWidth = useAppStore((state) => state.setVerticalTabListWidth)
  const collapsed = useAppStore((state) => state.verticalTabListCollapsed)
  const strip = resolveRenderedTabStrip({
    itemProjection,
    pinnedSortableIds: model.pinnedSortableIds,
    stripSortableIds: model.stripSortableIds,
    clientHostedBrowserRows: model.clientHostedBrowserRows
  })
  const homeCount = strip.pinnedCount
  const pinnedRowCount = countPinnedRows(strip.orderedItems, homeCount)
  // Why memoized: each section's SortableContext re-renders every row when its ids change identity.
  const pinnedIds = useMemo(
    () => model.stripSortableIds.slice(0, pinnedRowCount),
    [model.stripSortableIds, pinnedRowCount]
  )
  const restIds = useMemo(
    () => model.stripSortableIds.slice(pinnedRowCount),
    [model.stripSortableIds, pinnedRowCount]
  )
  const { scrollerRef, subscribeToResize, onKeyDown } = useVerticalTabListScroller({
    activeSlotId: activeClientHostedBrowserRowId ?? itemProjection.activeVisibleTabId,
    orderedItems: strip.orderedItems,
    actions: itemActions
  })
  // Why the shared sidebar hook: it writes the drag width to the DOM per frame and saves once on release.
  const { containerRef, isResizing, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: collapsed ? VERTICAL_TAB_LIST_COLLAPSED_WIDTH : width,
    minWidth: VERTICAL_TAB_LIST_MIN_WIDTH,
    maxWidth: VERTICAL_TAB_LIST_MAX_WIDTH,
    deltaSign: 1,
    measureMaxSize: measureMaxListWidth,
    setWidth
  })
  const { surfaceRef } = model
  const listRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      surfaceRef(node)
    },
    [containerRef, surfaceRef]
  )
  const renderItems = (segments: readonly TabStripSegment[], itemOffset: number) =>
    renderTabBarItems({
      items: strip.orderedItems,
      props,
      runtime,
      actions: itemActions,
      dropIndicatorByVisibleId: strip.dropIndicatorByVisibleId,
      includeTopTabBorder: false,
      activeClientHostedBrowserRowId,
      segments,
      itemOffset,
      axis: 'y'
    })
  const leadingCount = homeCount + pinnedRowCount
  const hasTrailingRows = restIds.length + strip.clientHostedBrowserRows.length > 0

  return (
    <TabStripOrientationContext.Provider value="vertical">
      <div
        ref={listRef}
        data-vertical-tab-list=""
        data-tab-group-tab-list-id={runtime.resolvedGroupId}
        data-worktree-id={worktreeId}
        data-collapsed={collapsed ? '' : undefined}
        className={cn(
          'relative flex h-full min-h-0 max-w-[50%] shrink-0 flex-col border-r border-border bg-tab-bar',
          // Collapsed rows keep only their icon; the label stays as the row's accessible name.
          'data-[collapsed]:[&_.tab-label]:sr-only data-[collapsed]:[&_[data-tab-strip-slot]_button]:hidden',
          'data-[collapsed]:[&_.lucide-pin]:hidden data-[collapsed]:[&_[data-tab-color-dot]]:hidden',
          'data-[collapsed]:[&_[data-tab-strip-slot]>div]:px-[10px]'
        )}
      >
        <VerticalTabListHeader
          props={props}
          model={model}
          collapsed={collapsed}
          excludedTabId={
            activeClientHostedBrowserRowId === null ? itemProjection.activeUnifiedTabId : null
          }
        />
        <TabStripPositionMenu>
          <div className="flex min-h-0 flex-1 flex-col">
            <WindowedTabStrip
              stripRef={scrollerRef}
              subscribeToStripResize={subscribeToResize}
              sortableIds={restIds}
              activeVisibleTabId={itemProjection.activeVisibleTabId}
              axis="y"
              renderStrip={(segments) => (
                <div
                  ref={scrollerRef}
                  role="tablist"
                  aria-orientation="vertical"
                  aria-label={t(
                    'auto.components.tab.bar.vertical.VerticalTabBar.114d8426d7',
                    'Tabs'
                  )}
                  // Tab drags clip drop targets to this box (tab-drag-collision.ts).
                  data-tab-strip-scroller=""
                  className="flex min-h-0 flex-1 flex-col scrollbar-sleek overflow-y-auto overflow-x-hidden px-1 pb-1"
                  onKeyDown={onKeyDown}
                >
                  <TabStripTooltipProvider>
                    {homeCount > 0 ? (
                      // A bot's Home keeps its own context, as in the strip: it never drags.
                      <SortableContext items={strip.pinnedSortableIds}>
                        {renderItems([{ kind: 'tabs', start: 0, end: homeCount }], 0)}
                      </SortableContext>
                    ) : null}
                    {pinnedRowCount > 0 ? (
                      <SortableContext items={pinnedIds}>
                        {renderItems([{ kind: 'tabs', start: 0, end: pinnedRowCount }], homeCount)}
                      </SortableContext>
                    ) : null}
                    {leadingCount > 0 && hasTrailingRows ? (
                      <div aria-hidden className="mx-1 my-1 h-px flex-none bg-border" />
                    ) : null}
                    {renderItems(segments, leadingCount)}
                    {strip.clientHostedBrowserRows.length > 0 ? (
                      <ClientHostedBrowserTabRows
                        rows={strip.clientHostedBrowserRows}
                        worktreeId={worktreeId}
                        groupId={runtime.resolvedGroupId}
                        groupActiveTabId={props.groupActiveTabId ?? null}
                        includeTopTabBorder={false}
                      />
                    ) : null}
                  </TabStripTooltipProvider>
                </div>
              )}
            />
          </div>
        </TabStripPositionMenu>
        {collapsed ? null : (
          <VerticalTabListResizeHandle
            width={width}
            isResizing={isResizing}
            onResizeStart={onResizeStart}
            onResetWidth={() => setWidth(VERTICAL_TAB_LIST_DEFAULT_WIDTH)}
            onStepWidth={(delta) => setWidth(width + delta)}
          />
        )}
      </div>
    </TabStripOrientationContext.Provider>
  )
}

export default React.memo(VerticalTabBar)
