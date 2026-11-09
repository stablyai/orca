import React from 'react'
import { SortableContext } from '@dnd-kit/sortable'
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
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import type { TabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import type { TabBarItemProjection } from './use-tab-bar-item-projection'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import { renderTabBarItems } from './tab-bar-item-surface'
import { renderTabBarNewTabMenu } from './tab-bar-new-tab-menu'
import ClientHostedBrowserTabRows from './ClientHostedBrowserTabRows'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'

const EMPTY_CLIENT_HOSTED_ROWS: readonly ClientHostedBrowserRow[] = []

export function renderTabBarSurface(
  {
    props,
    runtime,
    createMenu,
    itemProjection,
    tabStripNavigation,
    tabStripDragScroll,
    activeClientHostedBrowserRowId,
    itemActions,
    surfaceRef
  }: {
    props: TabBarProps
    runtime: TabBarRuntimeModel
    createMenu: TabBarCreateMenuController
    itemProjection: TabBarItemProjection
    tabStripNavigation: ReturnType<typeof useTabStripOverflowNavigation>
    tabStripDragScroll: ReturnType<typeof useTabStripDragScrollHandlers>
    activeClientHostedBrowserRowId: string | null
    itemActions: TabBarItemActions
    surfaceRef: (node: HTMLDivElement | null) => void
  },
  t: Translate = translate
): React.JSX.Element {
  const { worktreeId, tabStripChrome = 'default' } = props
  const { resolvedGroupId } = runtime
  const { orderedItems, sortableIds, dropIndicatorByVisibleId } = itemProjection
  const clientHostedBrowserRows = props.clientHostedBrowserRows ?? EMPTY_CLIENT_HOSTED_ROWS
  const {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip,
    subscribeToStripResize
  } = tabStripNavigation
  const singleTab = orderedItems.length + clientHostedBrowserRows.length === 1
  const includeTopTabBorder = tabStripChrome !== 'floating-panel'
  const renderedItems = renderTabBarItems({
    items: orderedItems,
    props,
    runtime,
    actions: itemActions,
    dropIndicatorByVisibleId,
    includeTopTabBorder,
    activeClientHostedBrowserRowId
  })

  const hasTabs = orderedItems.length + clientHostedBrowserRows.length > 0
  return (
    <div ref={surfaceRef} className="flex items-stretch h-full overflow-hidden flex-1 min-w-0">
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
      <SortableContext items={sortableIds}>
        {/* Why: no-drag lets tab interactions work inside the titlebar's drag region (outer container stays window-draggable). */}
        <div
          data-single-tab={singleTab ? '' : undefined}
          // Why: tabs are the only drag source, so a narrow pane clips the "+" before the last tab sliver.
          className={`group/tab-strip relative flex min-h-0 w-max max-w-full shrink ${
            hasTabs ? 'min-w-10' : 'min-w-0'
          }`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div
            ref={tabStripRef}
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
              {renderedItems}
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
      </SortableContext>
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
      {renderTabBarNewTabMenu(
        {
          props,
          runtime,
          createMenu,
          // Why: below 86px (40 tab floor + 36 "+" + 8 action padding + 2 sub-pixel slack) "+" would only clip; hide it whole so Tab never lands on it. Empty groups keep it.
          triggerClassName: `ml-2 my-auto ${hasTabs ? '@max-[86px]/tab-strip:hidden' : ''}`
        },
        t
      )}
    </div>
  )
}
