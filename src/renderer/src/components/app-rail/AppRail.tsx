import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, CalendarClock, Files, Layers, List, Smartphone } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
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
  APP_RAIL_ICON_SIZE,
  APP_RAIL_ICON_STROKE_WIDTH,
  APP_RAIL_ITEM_ATTRIBUTE,
  AppRailButton,
  RailItem,
  isAppRailItemId,
  type AppRailItemId
} from './AppRailButton'
import { AppRailMoreMenu, useAppRailSlotCapacity } from './AppRailMoreMenu'
import { AppRailCustomizeMenu, type AppRailCustomizeRow } from './AppRailCustomizeMenu'
import { AppRailAccountMenu } from './AppRailAccountMenu'
import { partitionAppRail } from './app-rail-overflow'
import { railItemOwningFocus } from './app-rail-focus-ownership'
import { useWorkspaceListRegionPresent } from './workspace-list-region-presence'
import {
  APP_RAIL_DESTINATION_IDS,
  activateRailDestination,
  selectCurrentRailDestination,
  selectShownRailDestinationsKey,
  setRailDestinationShown,
  shownRailDestinationsFromKey,
  type AppRailDestinationId
} from './app-rail-destinations'
import { getTitlebarSidebarToggle } from '@/app-shell/chrome/titlebar-sidebar-toggle-ref'

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
  const shownDestinationsKey = useAppStore(selectShownRailDestinationsKey)
  const currentDestination = useAppStore(selectCurrentRailDestination)
  const listShowsWorkspaces = useAppStore((s) => (s.sidebarBody ?? 'workspaces') === 'workspaces')
  const listRegionPresent = useWorkspaceListRegionPresent()
  const setupProgress = useSetupGuideProgressSnapshot()
  // The account menu's Milestones row and ring read the app-wide setup reading; the rail runs no setup checks itself.
  const milestones = useMemo(
    () =>
      setupProgress?.ready && setupProgress.done < setupProgress.total
        ? { done: setupProgress.done, total: setupProgress.total }
        : null,
    [setupProgress]
  )
  // Milestones sits at the top of the account menu, so Help's own list leaves it out. The rail owns the controller so
  // its feedback dialog outlives the account menu closing.
  const help = useHelpMenuController(null)

  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  // Why stable: a new ref callback each render makes React detach (null) and reattach it, and those two setToolbar
  // calls schedule an extra rail render per update when the compiler is off (ORCA_REACT_COMPILER=0).
  const attachToolbar = useCallback((node: HTMLDivElement | null) => {
    toolbarRef.current = node
    setToolbar(node)
  }, [])
  // Focus ownership sampled at the moment a fold/unfold is about to commit; only that transition may recover it.
  const transitionOwnerRef = useRef<AppRailItemId | null>(null)
  const capacity = useAppRailSlotCapacity(toolbar, () => {
    transitionOwnerRef.current = toolbarRef.current ? railItemOwningFocus(toolbarRef.current) : null
  })
  // Customize can change the shown set with its menu open; sample focus before that commits, as for a fold.
  useLayoutEffect(
    () =>
      useAppStore.subscribe((state, prev) => {
        if (
          state.settings !== prev.settings &&
          toolbarRef.current &&
          selectShownRailDestinationsKey(state) !== selectShownRailDestinationsKey(prev)
        ) {
          // A second change before the commit must not drop the owner the first one sampled.
          transitionOwnerRef.current =
            railItemOwningFocus(toolbarRef.current) ?? transitionOwnerRef.current
        }
      }),
    []
  )
  // Hidden destinations are left out before partitioning; hidden is never folded.
  const shownDestinations = shownRailDestinationsFromKey(shownDestinationsKey)
  const partition = partitionAppRail(shownDestinations.length, capacity)
  const railDestinations = shownDestinations.slice(0, partition.shownDestinations)
  const foldedDestinations = shownDestinations.slice(partition.shownDestinations)
  const destinationActive = (id: AppRailDestinationId): boolean => id === currentDestination

  const renderedItems: AppRailItemId[] = [
    'workspaces',
    ...railDestinations,
    partition.more ? 'more' : 'customize',
    'account'
  ]
  const shownCurrentDestination =
    currentDestination && shownDestinations.includes(currentDestination) ? currentDestination : null
  const activeItem: AppRailItemId | null = workspacesActive
    ? 'workspaces'
    : shownCurrentDestination
      ? railDestinations.includes(shownCurrentDestination)
        ? shownCurrentDestination
        : 'more'
      : settingsActive
        ? 'account'
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
  // An owner whose recovery frame has not run yet; a change that cancels the frame must hand it to the next one.
  const pendingRecoveryOwnerRef = useRef<AppRailItemId | null>(null)
  useLayoutEffect(() => {
    renderedItemsRef.current = renderedItems
  })
  // If the transition removed the focused button or its open menu, focus its new home: the button itself if it is
  // still rendered, else the "…" slot (More it folded into, or Customize/More swapping forms). Connected focus stays.
  useLayoutEffect(() => {
    const owner = transitionOwnerRef.current ?? pendingRecoveryOwnerRef.current
    transitionOwnerRef.current = null
    pendingRecoveryOwnerRef.current = owner
    if (!owner) {
      return
    }
    const frame = requestAnimationFrame(() => {
      pendingRecoveryOwnerRef.current = null
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) {
        return
      }
      const rendered = renderedItemsRef.current
      const home = rendered.includes(owner)
        ? owner
        : rendered.includes('more')
          ? 'more'
          : 'customize'
      toolbarRef.current
        ?.querySelector<HTMLElement>(`[${APP_RAIL_ITEM_ATTRIBUTE}="${home}"]`)
        ?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
    // The shown set is a dep so a sample taken for a change that moved nothing on the rail is consumed, not kept.
  }, [renderedKey, shownDestinationsKey])

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
  // The toolbar inside the landmark gets its own name so screen readers don't hear "App navigation" twice.
  const toolsLabel = t('appRail.toolsLabel', 'App tools')
  const workspacesLabel = t('appRail.workspaces', 'Workspaces')
  // The list rows' labels and icons, so the rail reads the same.
  const destinationLabel = (id: AppRailDestinationId): string => {
    switch (id) {
      case 'tasks':
        return t('auto.components.sidebar.SidebarNav.fee535205b', 'Tasks')
      case 'automations':
        return t('auto.components.sidebar.SidebarNav.f323383e9a', 'Automations')
      case 'artifacts':
        return t('auto.components.sidebar.SidebarNav.artifacts', 'Artifacts')
      case 'skills':
        return t('auto.components.sidebar.SidebarNav.skills', 'Skills')
      case 'mobile':
        return t('auto.components.sidebar.SidebarNav.1b5c41caee', 'Orca Mobile')
    }
  }
  const destinationIcon = (
    id: AppRailDestinationId,
    size: number,
    strokeWidth?: number,
    className?: string
  ): React.ReactNode => {
    const props = { size, strokeWidth, className, 'aria-hidden': true }
    switch (id) {
      case 'tasks':
        return <List {...props} />
      case 'automations':
        return <CalendarClock {...props} />
      case 'artifacts':
        return <Files {...props} />
      case 'skills':
        return <BookOpen {...props} />
      case 'mobile':
        return <Smartphone {...props} />
    }
  }
  const shownDestinationSet = new Set<AppRailDestinationId>(shownDestinations)
  // Every page but Workspaces, in rail order, shown or not.
  const customizeRows: AppRailCustomizeRow[] = APP_RAIL_DESTINATION_IDS.map((id) => ({
    id,
    label: destinationLabel(id),
    icon: destinationIcon(id, 14, undefined, 'size-3.5'),
    shown: shownDestinationSet.has(id),
    onToggle: () => setRailDestinationShown(id, !shownDestinationSet.has(id))
  }))
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
    // The account button is last, so ArrowDown opens its menu (Radix's trigger key) instead of wrapping to the top.
    if (
      event.key === 'ArrowDown' &&
      items[index].getAttribute(APP_RAIL_ITEM_ATTRIBUTE) === 'account'
    ) {
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
      {/* Why pb-1: the account button lines up with the list footer icons and its focus ring stays unclipped. */}
      <div
        ref={attachToolbar}
        role="toolbar"
        aria-orientation="vertical"
        aria-label={toolsLabel}
        className="flex min-h-0 flex-1 flex-col items-center justify-between overflow-hidden pt-2 pb-1"
        onKeyDownCapture={handleKeyDown}
        onFocus={handleFocus}
      >
        <div className="flex flex-col items-center gap-2.5">
          <RailItem tooltip={workspacesLabel}>
            <AppRailButton
              itemId="workspaces"
              icon={
                <Layers
                  size={APP_RAIL_ICON_SIZE}
                  strokeWidth={APP_RAIL_ICON_STROKE_WIDTH}
                  aria-hidden
                />
              }
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
          {railDestinations.map((id) => (
            <RailItem key={id} tooltip={destinationLabel(id)}>
              <AppRailButton
                itemId={id}
                icon={destinationIcon(id, APP_RAIL_ICON_SIZE, APP_RAIL_ICON_STROKE_WIDTH)}
                label={destinationLabel(id)}
                active={destinationActive(id)}
                tabStop={tabStopItem === id}
                onClick={() => activateRailDestination(id)}
              />
            </RailItem>
          ))}
          {partition.more ? (
            <AppRailMoreMenu
              tabStop={tabStopItem === 'more'}
              customizeRows={customizeRows}
              destinations={foldedDestinations.map((id) => ({
                id,
                label: destinationLabel(id),
                icon: destinationIcon(id, 14),
                current: destinationActive(id),
                // Automations focuses its own title when opened.
                ownsFocusOnOpen: id === 'automations',
                onSelect: () => activateRailDestination(id)
              }))}
            />
          ) : (
            <AppRailCustomizeMenu rows={customizeRows} tabStop={tabStopItem === 'customize'} />
          )}
        </div>
        <div className="flex flex-col items-center gap-2.5">
          <AppRailAccountMenu
            help={help}
            milestones={milestones}
            settingsActive={settingsActive}
            onOpenSettings={openSettings}
            tabStop={tabStopItem === 'account'}
          />
        </div>
        {/* Rendered outside the account menu so Send Feedback's dialog survives the menu closing. */}
        {help.dialog}
      </div>
    </nav>
  )
}
