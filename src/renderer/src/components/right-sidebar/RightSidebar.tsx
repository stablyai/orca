import React, { useEffect, useMemo, useRef, useState } from 'react'
import { PanelRight } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getTopActivityBarLayout } from './activity-bar/activity-bar-overflow'
import { ActivityBarButton } from './activity-bar/activity-bar-buttons'
import { getActiveChecksStatus } from './checks-panel/status/active-checks-status'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth,
  RIGHT_SIDEBAR_SIDE_ACTIVITY_BAR_WIDTH as ACTIVITY_BAR_SIDE_WIDTH
} from './layout/right-sidebar-width'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'
import { useMeasuredWidth } from './layout/right-sidebar-measured-width'
import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/app-shell/chrome/desktop-window-chrome'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import {
  ActivityBarPositionMenu,
  useActivityBarContextPlugin
} from './activity-bar/activity-bar-position-menu'
import { RightSidebarTopActivityBar } from './activity-bar/right-sidebar-top-activity-bar'
import { useRightSidebarActivityItems } from './activity-bar/use-right-sidebar-activity-items'
import { useRightSidebarTabRouting } from './activity-bar/use-right-sidebar-tab-routing'
import { useWindowWidth } from './layout/use-window-width'
import { usePluginViewCaptureStore } from '@/store/plugins/capture/plugin-view-capture'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'

function RightSidebarInner(): React.JSX.Element {
  const t = useTranslate()
  const contextPlugin = useActivityBarContextPlugin()
  useUiLanguageRevision()
  const hasDesktopWindowChrome = shouldRenderDesktopWindowChrome({
    platform: getRendererAppPlatform(),
    isWebClient: isPairedWebClientWindow()
  })
  const rightSidebarShortcut = useShortcutLabel('sidebar.right.toggle')
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const routeRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const settingsFocusRequested = useAppStore((s) => s.aiVaultSearchFocusRequested)
  const lastRouteRequestId = useRef(routeRequestId)
  const [focusVaultSearch, setFocusVaultSearch] = useState(false)
  const userRightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  // `orca plugin shot --width` sizes the panel for one capture without touching the saved width.
  const captureWidth = usePluginViewCaptureStore((s) => s.panelWidth)
  const rightSidebarWidth = captureWidth ?? userRightSidebarWidth
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  // Creation keeps the prior worktree active until handoff, so its panels would show that worktree.
  const creatingWorktree = useAppStore(selectWorktreeCreationSurfaceShown)
  const checksStatus = useAppStore((s) =>
    s.rightSidebarOpen && !creatingWorktree ? getActiveChecksStatus(s) : null
  )
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  const [topActivityStripWidth, setTopActivityStripWidth] = useState<number | null>(null)
  const {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys,
    redetectPerforce
  } = useRightSidebarActivityItems({ rightSidebarOpen })
  const { effectiveTab, selectActivityTab } = useRightSidebarTabRouting({
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  })

  useEffect(() => {
    if (lastRouteRequestId.current === routeRequestId) {
      if (!rightSidebarOpen || creatingWorktree || effectiveTab !== 'vault') {
        setFocusVaultSearch(false)
      }
      return
    }
    lastRouteRequestId.current = routeRequestId
    setFocusVaultSearch(
      rightSidebarOpen &&
        !creatingWorktree &&
        rightSidebarTab === 'vault' &&
        effectiveTab === 'vault' &&
        !settingsFocusRequested
    )
  }, [
    routeRequestId,
    rightSidebarOpen,
    rightSidebarTab,
    effectiveTab,
    creatingWorktree,
    settingsFocusRequested
  ])

  useEffect(() => {
    if (!focusVaultSearch) {
      return
    }
    const cancel = (): void => setFocusVaultSearch(false)
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    return () => {
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('keydown', cancel, true)
    }
  }, [focusVaultSearch])

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
    deltaSign: -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)

  const panelContent = rightSidebarOpen ? (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {creatingWorktree ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
          {t(
            'auto.components.right.sidebar.index.creatingWorkspace',
            'Available when the workspace is ready'
          )}
        </div>
      ) : (
        // Keep panels mounted across worktree switches; remounts caused Windows IPC storms and multi-second freezes.
        <RightSidebarPanelContent
          effectiveTab={effectiveTab}
          rightSidebarOpen={rightSidebarOpen}
          focusVaultSearch={focusVaultSearch}
          onVaultSearchFocusHandled={() => setFocusVaultSearch(false)}
        />
      )}
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
          aria-label={t('auto.components.right.sidebar.index.e8e2e4ce74', 'Toggle right sidebar')}
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {t('auto.components.right.sidebar.index.9fffaf17c1', 'Toggle right sidebar ({{value0}})', {
          value0: rightSidebarShortcut
        })}
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex-shrink-0 flex flex-row',
        // Allow the open resize handle to overflow; at width zero, clip mounted content and icons.
        rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'
      )}
    >
      <div
        className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
        style={{
          borderLeft: rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        {activityBarPosition === 'top' ? (
          <RightSidebarTopActivityBar
            hasDesktopWindowChrome={hasDesktopWindowChrome}
            topActivityStripRef={topActivityStripRef}
            topActivityLayout={topActivityLayout}
            effectiveTab={effectiveTab}
            onSelectTab={selectActivityTab}
            checksStatus={checksStatus}
            closeButton={closeButton}
            activityBarPosition={activityBarPosition}
            onChangeActivityBarPosition={setActivityBarPosition}
            onDetectPerforce={redetectPerforce}
          />
        ) : (
          /* The 40px activity bar absorbs part of the 138px window-control overlay; inset the header by the remaining 98px. */
          <div className="flex items-center justify-between h-[36px] min-h-[36px] px-3 border-b border-border right-sidebar-header-side-inset right-sidebar-header-drag">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
            <TooltipProvider>
              <div className="flex items-center">{closeButton}</div>
            </TooltipProvider>
          </div>
        )}

        {panelContent}

        <div
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
          onMouseDown={onResizeStart}
        />
      </div>

      {activityBarPosition === 'side' && (
        <ContextMenu>
          <ContextMenuTrigger
            asChild
            onContextMenu={contextPlugin.onContextMenu}
            onPointerDown={contextPlugin.onPointerDown}
          >
            <div className="flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-l border-border side-activity-bar-windows-inset">
              <TooltipProvider>{sideActivityBarIcons}</TooltipProvider>
            </div>
          </ContextMenuTrigger>
          <ActivityBarPositionMenu
            currentPosition={activityBarPosition}
            onChangePosition={setActivityBarPosition}
            onDetectPerforce={redetectPerforce}
            pluginKey={contextPlugin.pluginKey}
          />
        </ContextMenu>
      )}
    </div>
  )
}

const RightSidebar = React.memo(RightSidebarInner)
export default RightSidebar
