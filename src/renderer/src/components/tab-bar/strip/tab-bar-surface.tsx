import { WorkspaceCreateMenu } from '../WorkspaceCreateMenu'
import React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TabStripScrollIndicator } from './TabStripScrollIndicator'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'
import { getTabStripScrollMaskClassName } from './tab-strip-scroll-metrics'
import type { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'
import type { useTabStripDragScrollHandlers } from './tab-strip-drag-scroll'
import type { TabBarProps } from '../tab-bar-props'
import type { TabBarRuntimeModel } from '../model/use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from '../create-menu/tab-bar-create-menu-contract'
import type { TabBarItemProjection } from '../model/use-tab-bar-item-projection'
import type { TabBarItemActions } from '../model/use-tab-bar-item-actions'
import { renderTabBarItems } from '../model/tab-bar-item-surface'
import { WindowedTabStrip } from './WindowedTabStrip'
import type { TabStripSegment } from './tab-strip-window'
import ClientHostedBrowserTabRows from '../browser-tabs/ClientHostedBrowserTabRows'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotGroup } from '../../../../../shared/bots/bot-group'
import { PinnedHomeTabSlot } from './PinnedHomeTabSlot'
import {
  newTabButtonHideClassName,
  type RenderedTabStrip,
  stripSizeClassName
} from './rendered-tab-strip'

export function renderTabBarSurface(
  {
    props,
    runtime,
    createMenu,
    itemProjection,
    strip,
    tabStripNavigation,
    tabStripDragScroll,
    activeClientHostedBrowserRowId,
    itemActions,
    surfaceRef,
    bot,
    botGroup
  }: {
    props: TabBarProps
    runtime: TabBarRuntimeModel
    createMenu: TabBarCreateMenuController
    itemProjection: TabBarItemProjection
    /** What renders: a pinned bot Home in its own slot, then the scrolling strip's tabs. */
    strip: RenderedTabStrip
    tabStripNavigation: ReturnType<typeof useTabStripOverflowNavigation>
    tabStripDragScroll: ReturnType<typeof useTabStripDragScrollHandlers>
    activeClientHostedBrowserRowId: string | null
    itemActions: TabBarItemActions
    surfaceRef: (node: HTMLDivElement | null) => void
    /** Set in a bot's home, where the menu leads with a new chat with the bot. */
    bot: Bot | null
    /** Set in a group's home, where the menu leads with a new thread. */
    botGroup: BotGroup | null
  },
  t: Translate = translate
): React.JSX.Element {
  const { worktreeId, tabStripChrome = 'default' } = props
  const { resolvedGroupId } = runtime
  const { activeVisibleTabId } = itemProjection
  const {
    orderedItems,
    sortableIds,
    dropIndicatorByVisibleId,
    clientHostedBrowserRows,
    pinnedCount
  } = strip
  const {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip,
    subscribeToStripResize
  } = tabStripNavigation
  const singleTab = orderedItems.length + clientHostedBrowserRows.length === 1
  const includeTopTabBorder = tabStripChrome !== 'floating-panel'
  const renderItems = (
    segments: readonly TabStripSegment[],
    itemOffset = pinnedCount
  ): React.ReactNode[] =>
    renderTabBarItems({
      items: orderedItems,
      props,
      runtime,
      actions: itemActions,
      dropIndicatorByVisibleId,
      includeTopTabBorder,
      activeClientHostedBrowserRowId,
      segments,
      itemOffset
    })

  return (
    <div ref={surfaceRef} className="flex items-stretch h-full overflow-hidden flex-1 min-w-0">
      {pinnedCount > 0 ? (
        <PinnedHomeTabSlot
          sortableIds={strip.pinnedSortableIds}
          singleTab={singleTab}
          withStrip={strip.stripHasTabs}
        >
          {renderItems([{ kind: 'tabs', start: 0, end: pinnedCount }], 0)}
        </PinnedHomeTabSlot>
      ) : null}
      {tabStripOverflowState.hasOverflow ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mx-0.5 my-auto h-6 w-5 @max-[260px]/tab-strip:hidden"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              aria-label={t('auto.components.tab.bar.TabBar.7a9b4af2af', 'Scroll tabs left')}
              aria-disabled={!tabStripOverflowState.canScrollStart}
              disabled={
                !tabStripDragScroll.isTabDragActive && !tabStripOverflowState.canScrollStart
              }
              onClick={() => scrollTabStrip('start')}
              onPointerEnter={tabStripDragScroll.onDragScrollStartEnter}
              onPointerLeave={tabStripDragScroll.onDragScrollLeave}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('auto.components.tab.bar.TabBar.7a9b4af2af', 'Scroll tabs left')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* Keep drag siblings anchored; only the insertion bar moves. */}
      <WindowedTabStrip
        stripRef={tabStripRef}
        subscribeToStripResize={subscribeToStripResize}
        sortableIds={sortableIds}
        activeVisibleTabId={activeVisibleTabId}
        renderStrip={(segments) => (
          // Why no-drag: tab interactions must work inside the titlebar's drag region (outer container stays window-draggable).
          <div
            data-single-tab={singleTab ? '' : undefined}
            // Why: tabs are the only drag source, so a narrow pane clips the "+" before the last tab sliver.
            className={`group/tab-strip relative flex min-h-0 w-max max-w-full ${stripSizeClassName(strip)}`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div
              ref={tabStripRef}
              // Tab drags clip drop targets to this box (tab-drag-collision.ts).
              data-tab-strip-scroller=""
              data-active-tab-docked={activeTabDockSide ?? undefined}
              // Why: only `border-r` here — a strip-level `border-l` would render a heavier L-corner than the first tab's own `border-l`.
              className={[
                'terminal-tab-strip flex h-full min-w-0 max-w-full flex-1 items-stretch overflow-x-auto overflow-y-hidden',
                'border-r border-border/70',
                getTabStripScrollMaskClassName(tabStripOverflowState, activeTabDockSide)
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <TabStripTooltipProvider>
                {renderItems(segments)}
                {clientHostedBrowserRows.length > 0 ? (
                  <ClientHostedBrowserTabRows
                    rows={clientHostedBrowserRows}
                    worktreeId={worktreeId}
                    groupId={resolvedGroupId}
                    groupActiveTabId={props.groupActiveTabId ?? null}
                    includeTopTabBorder={includeTopTabBorder}
                  />
                ) : null}
              </TabStripTooltipProvider>
            </div>
            <TabStripScrollIndicator
              hasOverflow={tabStripOverflowState.hasOverflow}
              scrollContainerRef={tabStripRef}
              subscribeToStripResize={subscribeToStripResize}
              disabled={tabStripDragScroll.isTabDragActive}
            />
          </div>
        )}
      />
      {tabStripOverflowState.hasOverflow ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="mx-0.5 my-auto h-6 w-5 @max-[260px]/tab-strip:hidden"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              aria-label={t('auto.components.tab.bar.TabBar.232e075b07', 'Scroll tabs right')}
              aria-disabled={!tabStripOverflowState.canScrollEnd}
              disabled={!tabStripDragScroll.isTabDragActive && !tabStripOverflowState.canScrollEnd}
              onClick={() => scrollTabStrip('end')}
              onPointerEnter={tabStripDragScroll.onDragScrollEndEnter}
              onPointerLeave={tabStripDragScroll.onDragScrollLeave}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('auto.components.tab.bar.TabBar.232e075b07', 'Scroll tabs right')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <WorkspaceCreateMenu
        props={props}
        bot={bot}
        botGroup={botGroup}
        excludedTabId={
          activeClientHostedBrowserRowId === null ? itemProjection.activeUnifiedTabId : null
        }
        runtime={runtime}
        createMenu={createMenu}
        triggerClassName={newTabButtonHideClassName(strip)}
      />
    </div>
  )
}
