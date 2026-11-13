import React, { useLayoutEffect, useRef } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import type { Translate } from '@/i18n/use-translate'
import ClientHostedBrowserTabRows from './ClientHostedBrowserTabRows'
import { renderTabBarItems } from './tab-bar-item-surface'
import { renderTabBarNewTabMenu } from './tab-bar-new-tab-menu'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import type { TabBarItemProjection } from './use-tab-bar-item-projection'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { TAB_STRIP_ORIENTATION, TabStripOrientationProvider } from './tab-strip-orientation'
import { isTabStripPointerGestureActive } from './tab-strip-pointer-gesture'
import { findTabStripSlot } from './tab-strip-slot-geometry'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'

function VerticalTabList({
  activeSlotId,
  layoutKey,
  singleTab,
  children
}: {
  activeSlotId: string | null
  layoutKey: string
  singleTab: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const slot = list && activeSlotId ? findTabStripSlot(list, activeSlotId) : undefined
    // Hold the list through tab presses so it cannot slide under the pointer.
    if (!list || !slot || isTabStripPointerGestureActive()) {
      return
    }
    const listRect = list.getBoundingClientRect()
    const slotRect = slot.getBoundingClientRect()
    if (slotRect.top < listRect.top) {
      list.scrollTop -= listRect.top - slotRect.top
    } else if (slotRect.bottom > listRect.bottom) {
      list.scrollTop += slotRect.bottom - listRect.bottom
    }
  }, [activeSlotId, layoutKey])

  return (
    <div
      ref={listRef}
      data-single-tab={singleTab ? '' : undefined}
      className="group/tab-strip scrollbar-sleek flex min-h-0 flex-col overflow-y-auto overflow-x-hidden"
    >
      {children}
    </div>
  )
}

export function renderTabBarVerticalSurface(
  {
    props,
    runtime,
    createMenu,
    itemProjection,
    activeClientHostedBrowserRowId,
    itemActions,
    surfaceRef
  }: {
    props: TabBarProps
    runtime: TabBarRuntimeModel
    createMenu: TabBarCreateMenuController
    itemProjection: TabBarItemProjection
    activeClientHostedBrowserRowId: string | null
    itemActions: TabBarItemActions
    surfaceRef: (node: HTMLDivElement | null) => void
  },
  t: Translate
): React.JSX.Element {
  const { orderedItems, sortableIds, dropIndicatorByVisibleId, activeVisibleTabId } = itemProjection
  const clientHostedBrowserRows = props.clientHostedBrowserRows ?? []

  return (
    <TabStripOrientationProvider value={TAB_STRIP_ORIENTATION.vertical}>
      <div ref={surfaceRef} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <SortableContext items={sortableIds}>
          <VerticalTabList
            activeSlotId={activeClientHostedBrowserRowId ?? activeVisibleTabId}
            layoutKey={itemProjection.tabStripLayoutKey}
            singleTab={orderedItems.length + clientHostedBrowserRows.length === 1}
          >
            <TabStripTooltipProvider>
              {renderTabBarItems({
                items: orderedItems,
                props,
                runtime,
                actions: itemActions,
                dropIndicatorByVisibleId,
                includeTopTabBorder: false,
                activeClientHostedBrowserRowId
              })}
              {clientHostedBrowserRows.length > 0 ? (
                <ClientHostedBrowserTabRows
                  rows={clientHostedBrowserRows}
                  worktreeId={props.worktreeId}
                  groupId={runtime.resolvedGroupId}
                  groupActiveTabId={props.groupActiveTabId ?? null}
                  includeTopTabBorder={false}
                />
              ) : null}
            </TabStripTooltipProvider>
          </VerticalTabList>
        </SortableContext>
        {/* Why outside the list: "+" follows the last tab but stays reachable once the list scrolls. */}
        {renderTabBarNewTabMenu({ props, runtime, createMenu, triggerClassName: 'mx-1 my-1' }, t)}
      </div>
    </TabStripOrientationProvider>
  )
}
