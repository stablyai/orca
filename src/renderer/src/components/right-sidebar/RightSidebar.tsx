import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SidebarToggleIcon } from '@/components/icons/SidebarToggleIcon'
import { useAppStore } from '@/store/index'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/class-names'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { getTopActivityBarLayout } from './activity-bar/activity-bar-overflow'
import { measureTabTitle } from './right-sidebar-tab-title-width'
import { keepPaneFocusPressProps } from '@/lib/overlay-interaction/focus-keeping-press'
import { TopActivityOverflowMenu } from './activity-bar/activity-bar-buttons'
import { SortableActivityButton } from './activity-bar/sortable-activity-button'
import {
  activityOrderForPage,
  arrangeActivityItems,
  moveStripActivity,
  reorderActivityOrders
} from './activity-bar/activity-bar-arrangement'
import { getActiveChecksStatus } from './checks-panel/status/active-checks-status'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
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
import { RightSidebarGutterResizeProvider } from './layout/right-sidebar-gutter-resize'
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
import { cancelActivityBarFocusHandoff } from './activity-bar/activity-bar-focus-handoff'
import { activityBarDragAnnouncements } from './activity-bar/activity-bar-drag-announcements'
import {
  RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_PADDING,
  RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_PADDING
} from './layout/right-sidebar-titlebar-drag-regions'
import { useRightSidebarActivityItems } from './activity-bar/use-right-sidebar-activity-items'
import { useRightSidebarTabRouting } from './activity-bar/use-right-sidebar-tab-routing'
import { useWindowWidth } from './layout/use-window-width'
import { useBotPanelMemory } from '../bots/use-bot-panel-memory'
import { usePluginViewCaptureStore } from '@/store/plugins/capture/plugin-view-capture'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'

function RightSidebarInner({
  edge = 'right',
  windowControlsEdge = 'right'
}: {
  edge?: 'left' | 'right'
  windowControlsEdge?: 'left' | 'right' | null
}): React.JSX.Element {
  const onLeft = edge === 'left'
  const reserveWindowControls = !onLeft && windowControlsEdge === 'right'
  const t = useTranslate()
  const contextPlugin = useActivityBarContextPlugin()
  useUiLanguageRevision()
  useBotPanelMemory()
  const hasDesktopWindowChrome =
    reserveWindowControls &&
    shouldRenderDesktopWindowChrome({
      platform: getRendererAppPlatform(),
      isWebClient: isPairedWebClientWindow()
    })
  const rightSidebarShortcut = useShortcutLabel('sidebar.right.toggle')
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const routeRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const routeFocusesVaultSearch = useAppStore((s) => s.rightSidebarRouteFocusesVaultSearch)
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
    visibleItems: availableItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys,
    isBotPage
  } = useRightSidebarActivityItems({ rightSidebarOpen })
  const { effectiveTab, selectActivityTab } = useRightSidebarTabRouting({
    visibleItems: availableItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys,
    isBotPage
  })

  const { order, botOrder, hidden } = useAppStore(
    useShallow((s) => ({
      order: s.activityBarOrder,
      botOrder: s.activityBarBotOrder,
      hidden: s.activityBarHidden
    }))
  )
  const setOrder = useAppStore((s) => s.setActivityBarOrder)
  const setBotOrder = useAppStore((s) => s.setActivityBarBotOrder)
  const orderedItems = useMemo(
    () =>
      arrangeActivityItems(availableItems, activityOrderForPage({ order, botOrder }, isBotPage)),
    [availableItems, order, botOrder, isBotPage]
  )
  const visibleItems = useMemo(
    () => orderedItems.filter((item) => !hidden.includes(item.id) || !item.pluginKey),
    [orderedItems, hidden]
  )
  const hiddenActiveItem = orderedItems.find(
    (item) => item.id === effectiveTab && hidden.includes(item.id) && item.pluginKey
  )
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  useEffect(() => cancelActivityBarFocusHandoff, [])

  useEffect(() => {
    if (lastRouteRequestId.current === routeRequestId) {
      if (!rightSidebarOpen || creatingWorktree || effectiveTab !== 'vault') {
        setFocusVaultSearch(false)
      }
      return
    }
    lastRouteRequestId.current = routeRequestId
    setFocusVaultSearch(
      routeFocusesVaultSearch &&
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
    settingsFocusRequested,
    routeFocusesVaultSearch
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
  const { containerRef, isResizing, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: rightSidebarOpen,
    width: renderedRightSidebarWidth,
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH,
    maxWidth,
    deltaSign: onLeft ? 1 : -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)
  const resizeHandleRef = useRef<HTMLDivElement | null>(null)
  const gutterHoverOwnerRef = useRef<HTMLElement | null>(null)
  const onResizeStartRef = useRef(onResizeStart)
  useLayoutEffect(() => {
    onResizeStartRef.current = onResizeStart
  })
  // Stable, so the panels below never re-render for the resize callback's width-dependent identity.
  const gutterResize = useMemo(
    () => ({
      startResize: (event: React.MouseEvent) => onResizeStartRef.current(event),
      edge,
      containerRef,
      handleRef: resizeHandleRef,
      hoverOwnerRef: gutterHoverOwnerRef
    }),
    [containerRef, edge]
  )

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
        <RightSidebarGutterResizeProvider value={gutterResize}>
          <RightSidebarPanelContent
            effectiveTab={effectiveTab}
            rightSidebarOpen={rightSidebarOpen}
            focusVaultSearch={focusVaultSearch}
            onVaultSearchFocusHandled={() => setFocusVaultSearch(false)}
          />
        </RightSidebarGutterResizeProvider>
      )}
    </div>
  ) : null

  const topActivityLayout = useMemo(
    () =>
      getTopActivityBarLayout(
        visibleItems,
        topActivityStripWidth,
        effectiveTab,
        hasDesktopWindowChrome
          ? RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_PADDING
          : RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_PADDING,
        measureTabTitle,
        Boolean(hiddenActiveItem)
      ),
    [visibleItems, topActivityStripWidth, effectiveTab, hasDesktopWindowChrome, hiddenActiveItem]
  )

  const sideActivityBarIcons = visibleItems.map((item) => (
    <SortableActivityButton
      key={item.id}
      item={item}
      layout="side"
      active={effectiveTab === item.id}
      onClick={(fromKeyboard) => selectActivityTab(item.id, fromKeyboard)}
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
          {...keepPaneFocusPressProps}
          aria-label={
            onLeft
              ? t('menu.toggleLeftSidebar', 'Toggle Left Sidebar')
              : t('auto.components.right.sidebar.index.e8e2e4ce74', 'Toggle right sidebar')
          }
        >
          <SidebarToggleIcon side={edge} size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {onLeft
          ? t('auto.App.ce37cf5279', 'Toggle sidebar ({{value0}})', {
              value0: rightSidebarShortcut
            })
          : t(
              'auto.components.right.sidebar.index.9fffaf17c1',
              'Toggle right sidebar ({{value0}})',
              {
                value0: rightSidebarShortcut
              }
            )}
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[
        (args) => ({ ...args.transform, ...(activityBarPosition === 'top' ? { y: 0 } : { x: 0 }) })
      ]}
      accessibility={{ announcements: activityBarDragAnnouncements(orderedItems, t) }}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) {
          return
        }
        // The strip's sortable tabs reorder among their strip slots; tabs under More follow in order.
        const strip = activityBarPosition === 'top' ? topActivityLayout.visibleItems : visibleItems
        const next = moveStripActivity(
          visibleItems.map((item) => item.id),
          new Set(strip.map((item) => item.id)),
          String(active.id),
          String(over.id)
        )
        if (next) {
          const orders = reorderActivityOrders({ order, botOrder }, isBotPage, next)
          if (isBotPage) {
            setBotOrder(orders.botOrder)
          } else {
            setOrder(orders.order)
          }
        }
      }}
    >
      <div
        ref={containerRef}
        className={cn(
          'relative flex-shrink-0 flex',
          onLeft ? 'flex-row-reverse' : 'flex-row',
          // Allow the open resize handle to overflow; at width zero, clip mounted content and icons.
          rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'
        )}
      >
        <div
          className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
          style={{
            [onLeft ? 'borderRight' : 'borderLeft']: rightSidebarOpen
              ? '1px solid var(--sidebar-border)'
              : 'none'
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
              arrangementItems={orderedItems}
              hiddenActiveItem={hiddenActiveItem}
              isBotPage={isBotPage}
            />
          ) : (
            /* The 40px activity bar absorbs part of the 138px window-control overlay; inset the header by the remaining 98px. */
            <div
              className={cn(
                'flex h-(--app-header-height) min-h-(--app-header-height) items-center justify-between border-b border-border px-3 right-sidebar-header-drag',
                reserveWindowControls && 'right-sidebar-header-side-inset'
              )}
            >
              <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                {orderedItems.find((item) => item.id === effectiveTab)?.title ?? ''}
              </span>
              <TooltipProvider>
                <div className="flex items-center">{closeButton}</div>
              </TooltipProvider>
            </div>
          )}

          {panelContent}

          <div
            ref={resizeHandleRef}
            className={cn(
              onLeft ? 'right-0' : 'left-0',
              'absolute top-0 w-1 h-full cursor-col-resize hover:bg-ring/20 data-[gutter-hover]:bg-ring/20 active:bg-ring/30 transition-colors z-10',
              isResizing && 'bg-ring/30'
            )}
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
              <div
                className={cn(
                  'flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-border',
                  onLeft ? 'border-r' : 'border-l',
                  reserveWindowControls && 'side-activity-bar-windows-inset'
                )}
              >
                <TooltipProvider>
                  <SortableContext
                    items={visibleItems.map((item) => item.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {sideActivityBarIcons}
                  </SortableContext>
                  {hiddenActiveItem && (
                    <TopActivityOverflowMenu
                      items={[hiddenActiveItem]}
                      activeTab={effectiveTab}
                      onSelect={selectActivityTab}
                      checksStatus={checksStatus}
                      arrangementItems={orderedItems}
                      activityBarPosition={activityBarPosition}
                      onChangeActivityBarPosition={setActivityBarPosition}
                      isBotPage={isBotPage}
                    />
                  )}
                </TooltipProvider>
              </div>
            </ContextMenuTrigger>
            <ActivityBarPositionMenu
              currentPosition={activityBarPosition}
              onChangePosition={setActivityBarPosition}
              pluginKey={contextPlugin.pluginKey}
              itemId={contextPlugin.itemId}
              items={orderedItems}
              isBotPage={isBotPage}
            />
          </ContextMenu>
        )}
      </div>
    </DndContext>
  )
}

const RightSidebar = React.memo(RightSidebarInner)
export default RightSidebar
