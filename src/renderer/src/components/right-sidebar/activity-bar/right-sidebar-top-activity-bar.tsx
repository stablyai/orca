import React from 'react'
import type {
  ActiveRightSidebarTab,
  ActivityBarPosition
} from '../../../../../shared/ui-chrome/ui-chrome-types'
import type { CheckStatus as CoarseCheckStatus } from '../../../../../shared/github/pull-requests/pull-request-types'
type CheckStatus = CoarseCheckStatus | 'cancelled'
import { cn } from '@/lib/class-names'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  ActivityBarButton,
  TopActivityOverflowMenu,
  type ActivityBarItem
} from './activity-bar-buttons'
import type { TopActivityBarLayout } from './activity-bar-overflow'

import { ActivityBarPositionMenu, useActivityBarContextPlugin } from './activity-bar-position-menu'
import {
  RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
  RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME,
  RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME
} from '../layout/right-sidebar-titlebar-drag-regions'

export function RightSidebarTopActivityBar({
  hasDesktopWindowChrome,
  topActivityStripRef,
  topActivityLayout,
  effectiveTab,
  onSelectTab,
  checksStatus,
  closeButton,
  activityBarPosition,
  onChangeActivityBarPosition,
  onDetectPerforce
}: {
  hasDesktopWindowChrome: boolean
  topActivityStripRef: (node: HTMLDivElement | null) => void
  topActivityLayout: TopActivityBarLayout<ActivityBarItem>
  effectiveTab: ActiveRightSidebarTab
  onSelectTab: (tab: ActiveRightSidebarTab, fromKeyboard: boolean) => void
  checksStatus: CheckStatus | null
  closeButton: React.ReactNode
  activityBarPosition: ActivityBarPosition
  onChangeActivityBarPosition: (pos: ActivityBarPosition) => void
  onDetectPerforce?: () => void
}): React.JSX.Element {
  const contextPlugin = useActivityBarContextPlugin()
  const pillGap = topActivityLayout.visibleItems.some((item) => item.labeledTab) && 'gap-0.5'
  const tabs = topActivityLayout.visibleItems.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={effectiveTab === item.id}
      onClick={(fromKeyboard) => onSelectTab(item.id, fromKeyboard)}
      layout="top"
      statusIndicator={item.id === 'checks' ? checksStatus : null}
      compact={topActivityLayout.compactIds.has(item.id)}
    />
  ))
  return (
    <ContextMenu>
      <div className="flex h-(--app-header-height) min-h-(--app-header-height) items-center overflow-hidden border-b border-border right-sidebar-header-inset right-sidebar-header-drag">
        {!hasDesktopWindowChrome && (
          <TooltipProvider>
            <ContextMenuTrigger
              asChild
              onContextMenu={contextPlugin.onContextMenu}
              onPointerDown={contextPlugin.onPointerDown}
            >
              <div
                ref={topActivityStripRef}
                className={RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME}
              >
                <div className={cn('flex min-w-0 shrink', RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)}>
                  {/* Use More for overflow because this narrow titlebar also holds close/window controls. */}
                  <div className={cn('flex min-w-0 shrink items-center', pillGap)}>{tabs}</div>
                  {topActivityLayout.overflowItems.length > 0 && (
                    <TopActivityOverflowMenu
                      items={topActivityLayout.overflowItems}
                      activeTab={effectiveTab}
                      onSelect={onSelectTab}
                      checksStatus={checksStatus}
                    />
                  )}
                </div>
              </div>
            </ContextMenuTrigger>
            <div
              className={cn(
                'flex shrink-0 items-center pr-1',
                RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
              )}
            >
              {closeButton}
            </div>
          </TooltipProvider>
        )}
        {hasDesktopWindowChrome && (
          <TooltipProvider>
            <div
              className={cn(
                'ml-auto flex shrink-0 items-center pr-1',
                RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
              )}
            >
              {closeButton}
            </div>
          </TooltipProvider>
        )}
      </div>
      {hasDesktopWindowChrome && (
        <TooltipProvider>
          <ContextMenuTrigger
            asChild
            onContextMenu={contextPlugin.onContextMenu}
            onPointerDown={contextPlugin.onPointerDown}
          >
            <div
              ref={topActivityStripRef}
              className={RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME}
            >
              {/* Keep navigation in the body so custom desktop titlebars remain visually native and uncrowded. */}
              <div className={cn('flex min-w-0 flex-1 shrink items-center', pillGap)}>{tabs}</div>
              {topActivityLayout.overflowItems.length > 0 && (
                <TopActivityOverflowMenu
                  items={topActivityLayout.overflowItems}
                  activeTab={effectiveTab}
                  onSelect={onSelectTab}
                  checksStatus={checksStatus}
                />
              )}
            </div>
          </ContextMenuTrigger>
        </TooltipProvider>
      )}
      <ActivityBarPositionMenu
        currentPosition={activityBarPosition}
        onChangePosition={onChangeActivityBarPosition}
        onDetectPerforce={onDetectPerforce}
        pluginKey={contextPlugin.pluginKey}
      />
    </ContextMenu>
  )
}
