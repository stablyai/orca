import React from 'react'
import type { ActiveRightSidebarTab, ActivityBarPosition } from '@/store/slices/editor'
import type { CheckStatus } from '../../../../shared/github/pull-request-types'
import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ActivityBarButton, TopActivityOverflowMenu } from './activity-bar-buttons'
import type { ActivityBarItem } from './activity-bar-buttons'
import { ActivityBarPositionMenu } from './activity-bar-position-menu'
import {
  RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
  RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME,
  RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME
} from './right-sidebar-titlebar-drag-regions'

export function RightSidebarTopActivityBar({
  hasDesktopWindowChrome,
  topActivityStripRef,
  topActivityLayout,
  effectiveTab,
  onSelectTab,
  checksStatus,
  closeButton,
  activityBarPosition,
  onChangeActivityBarPosition
}: {
  hasDesktopWindowChrome: boolean
  topActivityStripRef: (node: HTMLDivElement | null) => void
  topActivityLayout: { visibleItems: ActivityBarItem[]; overflowItems: ActivityBarItem[] }
  effectiveTab: ActiveRightSidebarTab
  onSelectTab: (tab: ActiveRightSidebarTab) => void
  checksStatus: CheckStatus | null
  closeButton: React.ReactNode
  activityBarPosition: ActivityBarPosition
  onChangeActivityBarPosition: (pos: ActivityBarPosition) => void
}): React.JSX.Element {
  return (
    /* ── Top activity bar: horizontal icon row ── */
    <ContextMenu>
      <div className="flex h-[36px] min-h-[36px] items-center border-b border-border right-sidebar-header-inset right-sidebar-header-drag overflow-hidden">
        {!hasDesktopWindowChrome && (
          <TooltipProvider delayDuration={400}>
            <ContextMenuTrigger asChild>
              <div
                ref={topActivityStripRef}
                className={RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME}
              >
                <div className={cn('flex min-w-0 shrink', RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)}>
                  {/* Why: the top strip shares a narrow titlebar with the close
                      button and desktop window controls. Overflow goes
                      behind More instead of creating a horizontally
                      scrollable toolbar. */}
                  <div className="flex min-w-0 shrink">
                    {topActivityLayout.visibleItems.map((item) => (
                      <ActivityBarButton
                        key={item.id}
                        item={item}
                        active={effectiveTab === item.id}
                        onClick={() => onSelectTab(item.id)}
                        layout="top"
                        statusIndicator={item.id === 'checks' ? checksStatus : null}
                      />
                    ))}
                  </div>
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
          <TooltipProvider delayDuration={400}>
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
        <TooltipProvider delayDuration={400}>
          <ContextMenuTrigger asChild>
            <div
              ref={topActivityStripRef}
              className={RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME}
            >
              {/* Why: custom desktop chrome has fixed native-style controls
                  in the titlebar area; keep sidebar navigation in the
                  sidebar body so the titlebar stays visually native
                  instead of crowded. */}
              <div className="flex min-w-0 flex-1 shrink">
                {topActivityLayout.visibleItems.map((item) => (
                  <ActivityBarButton
                    key={item.id}
                    item={item}
                    active={effectiveTab === item.id}
                    onClick={() => onSelectTab(item.id)}
                    layout="top"
                    statusIndicator={item.id === 'checks' ? checksStatus : null}
                  />
                ))}
              </div>
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
      />
    </ContextMenu>
  )
}
