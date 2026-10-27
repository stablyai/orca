import React, { useMemo, useState } from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getTopActivityBarLayout } from './activity-bar-overflow'
import { ActivityBarButton } from './activity-bar-buttons'
import { getActiveChecksStatus } from './active-checks-status'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth
} from './right-sidebar-width'
import { translate } from '@/i18n/i18n'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'
import { useMeasuredWidth } from './right-sidebar-measured-width'
import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/lib/desktop-window-chrome'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { ActivityBarPositionMenu } from './activity-bar-position-menu'
import { RightSidebarTopActivityBar } from './right-sidebar-top-activity-bar'
import { useRightSidebarActivityItems } from './use-right-sidebar-activity-items'
import { useRightSidebarTabRouting } from './use-right-sidebar-tab-routing'
import { useWindowWidth } from './use-window-width'

const ACTIVITY_BAR_SIDE_WIDTH = 40

function RightSidebarInner({
  side = 'right',
  reserveTitlebarSpace = false
}: {
  side?: 'left' | 'right'
  reserveTitlebarSpace?: boolean
}): React.JSX.Element {
  const onLeft = side === 'left'
  const ToggleIcon = onLeft ? PanelLeft : PanelRight
  const hasDesktopWindowChrome = shouldRenderDesktopWindowChrome({
    platform: getRendererAppPlatform(),
    isWebClient: isPairedWebClientWindow()
  })
  const rightSidebarShortcut = useShortcutLabel('sidebar.right.toggle')
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const checksStatus = useAppStore((s) => (s.rightSidebarOpen ? getActiveChecksStatus(s) : null))
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  const [topActivityStripWidth, setTopActivityStripWidth] = useState<number | null>(null)
  const {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  } = useRightSidebarActivityItems({ rightSidebarOpen })
  const { effectiveTab, selectActivityTab } = useRightSidebarTabRouting({
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  })

  const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0
  const windowWidth = useWindowWidth()
  const maxWidth = computeMaxRightSidebarPanelWidth(windowWidth, activityBarSideWidth)
  const renderedRightSidebarWidth = clampRightSidebarPanelWidth(
    rightSidebarWidth,
    windowWidth,
    activityBarSideWidth
  )
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: rightSidebarOpen,
    width: renderedRightSidebarWidth,
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH,
    maxWidth,
    deltaSign: onLeft ? 1 : -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)

  const panelContent = rightSidebarOpen ? (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {/* Keep panels mounted across worktree switches; remounts caused Windows IPC storms and multi-second freezes. */}
      <RightSidebarPanelContent effectiveTab={effectiveTab} rightSidebarOpen={rightSidebarOpen} />
    </div>
  ) : null

  const topActivityLayout = useMemo(
    () => getTopActivityBarLayout(visibleItems, topActivityStripWidth, effectiveTab),
    [visibleItems, topActivityStripWidth, effectiveTab]
  )

  const sideActivityBarIcons = visibleItems.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={effectiveTab === item.id}
      onClick={() => selectActivityTab(item.id)}
      layout="side"
      sidebarSide={side}
      statusIndicator={item.id === 'checks' ? checksStatus : null}
    />
  ))

  const closeButton = rightSidebarOpen ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle mr-1"
          onClick={toggleRightSidebar}
          aria-label={translate(
            'auto.components.right.sidebar.index.e8e2e4ce74',
            'Toggle right sidebar'
          )}
        >
          <ToggleIcon size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate(
          'auto.components.right.sidebar.index.9fffaf17c1',
          'Toggle right sidebar ({{value0}})',
          { value0: rightSidebarShortcut }
        )}
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <div
      ref={containerRef}
      data-tools-sidebar-side={side}
      className={cn(
        'relative flex-shrink-0 flex flex-row',
        reserveTitlebarSpace && 'pt-9 bg-sidebar',
        // Why: overflow-visible is needed when open so the resize handle
        // on the outer edge remains interactive.  When closed (width 0),
        // switch to overflow-hidden so the activity bar icons and panel
        // content don't leak past the 0-width boundary (the component
        // stays mounted for performance — see App.tsx).
        rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'
      )}
    >
      <div
        className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
        style={{
          borderLeft: !onLeft && rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none',
          borderRight: onLeft && rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        {activityBarPosition === 'top' ? (
          <RightSidebarTopActivityBar
            hasDesktopWindowChrome={hasDesktopWindowChrome && !onLeft}
            atWindowEdge={!onLeft}
            topActivityStripRef={topActivityStripRef}
            topActivityLayout={topActivityLayout}
            effectiveTab={effectiveTab}
            onSelectTab={selectActivityTab}
            checksStatus={checksStatus}
            closeButton={closeButton}
            activityBarPosition={activityBarPosition}
            onChangeActivityBarPosition={setActivityBarPosition}
          />
        ) : (
          /* ── Side layout: static title header ── */
          <div
            className={cn(
              'flex items-center justify-between h-[36px] min-h-[36px] px-3 border-b border-border right-sidebar-header-drag',
              !onLeft && 'right-sidebar-header-side-inset'
            )}
          >
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
            <TooltipProvider delayDuration={400}>
              <div className="flex items-center">{closeButton}</div>
            </TooltipProvider>
          </div>
        )}

        {panelContent}

        {/* Resize from the edge facing the workbench. */}
        <div
          data-tools-sidebar-resize=""
          className={cn(
            'absolute top-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10',
            onLeft ? 'right-0' : 'left-0'
          )}
          onMouseDown={onResizeStart}
        />
      </div>

      {/* Keep the activity strip on the outside edge in either layout. */}
      {activityBarPosition === 'side' && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn(
                'flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-border',
                onLeft ? 'order-first border-r' : 'border-l side-activity-bar-windows-inset'
              )}
            >
              <TooltipProvider delayDuration={400}>{sideActivityBarIcons}</TooltipProvider>
            </div>
          </ContextMenuTrigger>
          <ActivityBarPositionMenu
            currentPosition={activityBarPosition}
            onChangePosition={setActivityBarPosition}
          />
        </ContextMenu>
      )}
    </div>
  )
}

const RightSidebar = React.memo(RightSidebarInner)
export default RightSidebar
