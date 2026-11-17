import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CircleHelp, Layers, Settings } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsTooltipLabel } from '@/components/sidebar/chrome/SidebarSettingsHelpMenu'
import { HelpMenuView } from '@/components/sidebar/chrome/HelpMenu'
import { useHelpMenuController } from '@/components/sidebar/chrome/help-menu-controller'
import { useSetupGuideProgressSnapshot } from '@/components/setup-guide/setup-guide-progress-snapshot'
import { nextAppRailFocusIndex } from './app-rail-roving-focus'
import { WORKSPACE_LIST_REGION_ID } from './app-rail-layout'
import {
  activateWorkspacesRailItem,
  isWorkspacesRailItemActive,
  navigateFromRail
} from './app-rail-navigation'
import {
  APP_RAIL_ITEM_ATTRIBUTE,
  AppRailButton,
  RailItem,
  isAppRailItemId,
  type AppRailItemId
} from './AppRailButton'
import { AppRailMoreMenu, useAppRailSlotCapacity } from './AppRailMoreMenu'
import { partitionAppRail } from './app-rail-overflow'
import { railItemOwningFocus } from './app-rail-focus-ownership'
import { useWorkspaceListRegionPresent } from './workspace-list-region-presence'
import { getTitlebarSidebarToggle } from '@/app-shell/chrome/titlebar-sidebar-toggle-ref'

const ICON_SIZE = 18

/** Icon-only app navigation below the left titlebar; one tab stop, arrow keys move within it. */
export function AppRail({
  listVisible,
  style
}: {
  listVisible: boolean
  style?: React.CSSProperties
}): React.JSX.Element {
  const t = useTranslate()
  const workspacesActive = useAppStore(isWorkspacesRailItemActive)
  const settingsActive = useAppStore((s) => s.activeView === 'settings')
  const listShowsWorkspaces = useAppStore((s) => (s.sidebarBody ?? 'workspaces') === 'workspaces')
  const listRegionPresent = useWorkspaceListRegionPresent()
  const setupProgress = useSetupGuideProgressSnapshot()
  // Help's Milestones row reads the app-wide setup reading; the rail runs no setup checks of its own.
  const helpMilestones = useMemo(
    () =>
      setupProgress?.ready && setupProgress.done < setupProgress.total
        ? { done: setupProgress.done, total: setupProgress.total }
        : null,
    [setupProgress]
  )
  // One Help owner for the rail's lifetime, so Help moving into More never remounts an open feedback dialog.
  const help = useHelpMenuController(helpMilestones)

  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  // Focus ownership sampled at the moment a fold/unfold is about to commit; only that transition may recover it.
  const transitionOwnerRef = useRef<AppRailItemId | null>(null)
  const capacity = useAppRailSlotCapacity(toolbar, () => {
    transitionOwnerRef.current = toolbarRef.current ? railItemOwningFocus(toolbarRef.current) : null
  })
  const partition = partitionAppRail(0, capacity)

  const renderedItems: AppRailItemId[] = [
    'workspaces',
    ...(partition.more ? (['more'] as const) : []),
    ...(partition.helpInMore ? [] : (['help'] as const)),
    ...(partition.settingsInMore ? [] : (['settings'] as const))
  ]
  const activeItem: AppRailItemId | null = workspacesActive
    ? 'workspaces'
    : settingsActive
      ? partition.settingsInMore
        ? 'more'
        : 'settings'
      : null
  const [lastFocusedItem, setLastFocusedItem] = useState<AppRailItemId | null>(null)
  const tabStopItem =
    lastFocusedItem && renderedItems.includes(lastFocusedItem)
      ? lastFocusedItem
      : activeItem && renderedItems.includes(activeItem)
        ? activeItem
        : renderedItems[0]

  const renderedKey = renderedItems.join(',')
  const renderedItemsRef = useRef(renderedItems)
  const tabStopRef = useRef(tabStopItem)
  useLayoutEffect(() => {
    renderedItemsRef.current = renderedItems
    tabStopRef.current = tabStopItem
  })
  // If the transition removed the focused button or its open menu, focus its new home: the button itself if it is
  // still rendered, else More (it folded in), else the tab stop. Focus that is still connected is left alone.
  useLayoutEffect(() => {
    const owner = transitionOwnerRef.current
    transitionOwnerRef.current = null
    if (!owner) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) {
        return
      }
      const rendered = renderedItemsRef.current
      const home = rendered.includes(owner)
        ? owner
        : rendered.includes('more')
          ? 'more'
          : tabStopRef.current
      toolbarRef.current
        ?.querySelector<HTMLElement>(`[${APP_RAIL_ITEM_ATTRIBUTE}="${home}"]`)
        ?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [renderedKey])

  // Turning the experiment off unmounts the rail (cleanup runs before its nodes leave the DOM): if a rail button or a
  // menu opened from one has focus, hand it to the titlebar's sidebar toggle, else blur. Other focus is untouched.
  useLayoutEffect(() => {
    const ownedToolbar = toolbarRef.current
    return () => {
      if (!ownedToolbar || railItemOwningFocus(ownedToolbar) === null) {
        return
      }
      const fallback = getTitlebarSidebarToggle()
      if (fallback) {
        fallback.focus({ preventScroll: true })
      } else {
        const active = document.activeElement
        if (active instanceof HTMLElement) {
          active.blur()
        }
      }
    }
  }, [])

  const navigationLabel = t('appRail.navigationLabel', 'App navigation')
  const workspacesLabel = t('appRail.workspaces', 'Workspaces')
  const settingsLabel = t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')
  const helpLabel = t('auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c', 'Help')
  const openSettings = (): void => useAppStore.getState().openSettingsPage()

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLElement>(`[${APP_RAIL_ITEM_ATTRIBUTE}]`) ?? []
    )
    // Capture phase + preventDefault keeps Radix menu triggers from opening on ArrowDown; menu content portals but still propagates here, so only rail buttons rove.
    const target = event.target
    const index = target instanceof HTMLElement ? items.indexOf(target) : -1
    if (index === -1) {
      return
    }
    const next = nextAppRailFocusIndex(event.key, index, items.length)
    if (next === null) {
      return
    }
    event.preventDefault()
    items[next].focus()
  }

  const handleFocus = (event: React.FocusEvent<HTMLDivElement>): void => {
    const itemId =
      event.target instanceof HTMLElement
        ? event.target.getAttribute(APP_RAIL_ITEM_ATTRIBUTE)
        : null
    if (isAppRailItemId(itemId)) {
      setLastFocusedItem(itemId)
    }
  }

  return (
    <nav
      aria-label={navigationLabel}
      className="flex min-h-0 w-10 flex-1 shrink-0 flex-col border-r border-worktree-sidebar-border bg-worktree-sidebar"
      style={style}
    >
      <div
        ref={(node) => {
          toolbarRef.current = node
          setToolbar(node)
        }}
        role="toolbar"
        aria-orientation="vertical"
        aria-label={navigationLabel}
        className="flex min-h-0 flex-1 flex-col items-center justify-between overflow-hidden py-2"
        onKeyDownCapture={handleKeyDown}
        onFocus={handleFocus}
      >
        <div className="flex flex-col items-center gap-1">
          <RailItem tooltip={workspacesLabel}>
            <AppRailButton
              itemId="workspaces"
              icon={<Layers size={ICON_SIZE} aria-hidden />}
              label={workspacesLabel}
              active={workspacesActive}
              // Expansion describes only the content actually in the list column.
              aria-expanded={listShowsWorkspaces ? listVisible : undefined}
              aria-controls={
                listShowsWorkspaces && listRegionPresent ? WORKSPACE_LIST_REGION_ID : undefined
              }
              tabStop={tabStopItem === 'workspaces'}
              onClick={() => navigateFromRail(() => activateWorkspacesRailItem(useAppStore))}
            />
          </RailItem>
          {partition.more ? (
            <AppRailMoreMenu
              help={help}
              includeHelp={partition.helpInMore}
              includeSettings={partition.settingsInMore}
              settingsActive={settingsActive}
              onOpenSettings={openSettings}
              tabStop={tabStopItem === 'more'}
            />
          ) : null}
        </div>
        <div className="flex flex-col items-center gap-1">
          {partition.helpInMore ? null : (
            <HelpMenuView
              controller={help}
              side="right"
              align="end"
              trigger={
                <AppRailButton
                  itemId="help"
                  icon={<CircleHelp size={ICON_SIZE} aria-hidden />}
                  label={helpLabel}
                  tabStop={tabStopItem === 'help'}
                />
              }
            />
          )}
          {partition.settingsInMore ? null : (
            <RailItem tooltip={<SettingsTooltipLabel />}>
              <AppRailButton
                itemId="settings"
                icon={<Settings size={ICON_SIZE} aria-hidden />}
                label={settingsLabel}
                active={settingsActive}
                tabStop={tabStopItem === 'settings'}
                onClick={openSettings}
              />
            </RailItem>
          )}
        </div>
        {/* Rendered once, outside both Help presentations, so folding Help keeps an open dialog. */}
        {help.dialog}
      </div>
    </nav>
  )
}
