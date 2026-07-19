import React from 'react'
import {
  Bell,
  CalendarClock,
  ChevronRight,
  Globe,
  Search,
  Smartphone,
  SquareTerminal
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import type { PinnedTerminalPanel } from '../../../../shared/types'
import { PINNED_TERMINAL_PANELS_ROOT_FOLD } from '../../../../shared/pinned-terminal-panels'
import { cn } from '@/lib/utils'
import type { GlobalSettings } from '../../../../shared/types'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useMobileSidebarOnboardingBadge } from './mobile-sidebar-onboarding-badge'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { SetupGuideSidebarEntry } from './SetupGuideSidebarEntry'
import { SidebarTaskNavButton } from './SidebarTaskNavButton'
import { HideSidebarMenu } from './sidebar-nav-controls'
import { translate } from '@/i18n/i18n'

export { getSetupGuideSidebarEntryReady, shouldShowSetupGuideEntry } from './SetupGuideSidebarEntry'

export function shouldShowAgentsButton(
  settings: Pick<GlobalSettings, 'experimentalActivity'> | null | undefined
): boolean {
  return settings?.experimentalActivity === true
}

export function shouldShowMobileButton(
  settings: Pick<GlobalSettings, 'showMobileButton'> | null | undefined
): boolean {
  return settings?.showMobileButton !== false
}

export function shouldShowAutomationsButton(
  settings: Pick<GlobalSettings, 'showAutomationsButton'> | null | undefined
): boolean {
  return settings?.showAutomationsButton !== false
}

function PinnedTerminalPanelButton({
  panel,
  active,
  nested = false,
  onOpen
}: {
  panel: PinnedTerminalPanel
  active: boolean
  nested?: boolean
  onOpen: (panelId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(panel.id)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px] font-medium tracking-tight transition-colors',
        nested ? 'pl-8' : 'pl-2',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <SquareTerminal
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="min-w-0 flex-1 truncate">{panel.title}</span>
    </button>
  )
}

const SidebarNav = React.memo(function SidebarNav() {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const worktreePaletteShortcutCombos = useShortcutKeyComboDetails('worktree.palette')
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const openMobilePage = useAppStore((s) => s.openMobilePage)
  const openPinnedWebPanelPage = useAppStore((s) => s.openPinnedWebPanelPage)
  const activePinnedWebPanelId = useAppStore((s) => s.activePinnedWebPanelId)
  const pinnedWebPanels = useAppStore((s) => s.settings?.pinnedWebPanels)
  const openPinnedTerminalPanelPage = useAppStore((s) => s.openPinnedTerminalPanelPage)
  const activePinnedTerminalPanelId = useAppStore((s) => s.activePinnedTerminalPanelId)
  const pinnedTerminalPanels = useAppStore((s) => s.settings?.pinnedTerminalPanels)
  const collapsedGroupsSetting = useAppStore((s) => s.settings?.collapsedPinnedTerminalPanelGroups)
  const collapsedTerminalPanelGroups = React.useMemo(
    () => new Set(collapsedGroupsSetting ?? []),
    [collapsedGroupsSetting]
  )
  const updateSettingsForGroups = useAppStore((s) => s.updateSettings)
  const toggleTerminalPanelGroup = React.useCallback(
    (group: string) => {
      const next = new Set(collapsedTerminalPanelGroups)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      void updateSettingsForGroups({ collapsedPinnedTerminalPanelGroups: [...next].sort() })
    },
    [collapsedTerminalPanelGroups, updateSettingsForGroups]
  )
  // Why: sections keep first-appearance order from settings; panels stay in
  // authored order inside their group so the rail mirrors the settings list.
  const groupedTerminalPanels = React.useMemo(() => {
    const sections: { group: string | null; panels: PinnedTerminalPanel[] }[] = []
    const sectionByGroup = new Map<
      string,
      { group: string | null; panels: PinnedTerminalPanel[] }
    >()
    for (const panel of pinnedTerminalPanels ?? []) {
      const group = panel.group ?? null
      if (group === null) {
        sections.push({ group: null, panels: [panel] })
        continue
      }
      let section = sectionByGroup.get(group)
      if (!section) {
        section = { group, panels: [] }
        sectionByGroup.set(group, section)
        sections.push(section)
      }
      section.panels.push(panel)
    }
    return sections
  }, [pinnedTerminalPanels])
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeView = useAppStore((s) => s.activeView)
  const showAgentsButton = useAppStore((s) => shouldShowAgentsButton(s.settings))
  const showAutomationsButton = useAppStore((s) => shouldShowAutomationsButton(s.settings))
  const showMobileButton = useAppStore((s) => shouldShowMobileButton(s.settings))
  const automationsActive = activeView === 'automations'
  const activityActive = activeView === 'activity'
  const mobileActive = activeView === 'mobile'
  const activityUnreadCount = useActivityUnreadCount(showAgentsButton, 'sidebar-badge')
  const mobileOnboardingBadge = useMobileSidebarOnboardingBadge(showMobileButton)
  const hideAutomationsButton = React.useCallback(() => {
    void updateSettings({ showAutomationsButton: false })
  }, [updateSettings])
  const hideMobileButton = React.useCallback(() => {
    void updateSettings({ showMobileButton: false })
  }, [updateSettings])

  return (
    <div
      className="flex flex-col gap-0.5 px-2 pt-2 pb-1"
      data-contextual-tour-target="sidebar-navigation"
    >
      <SetupGuideSidebarEntry />
      <SidebarTaskNavButton />
      {showAutomationsButton ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={openAutomationsPage}
              aria-current={automationsActive ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
                automationsActive
                  ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
              )}
            >
              <CalendarClock
                className={cn(
                  'size-4 shrink-0',
                  !automationsActive && 'text-worktree-sidebar-foreground/30'
                )}
                strokeWidth={automationsActive ? 2.25 : 1.75}
              />
              <span className="flex-1">
                {translate('auto.components.sidebar.SidebarNav.f323383e9a', 'Automations')}
              </span>
            </button>
          </ContextMenuTrigger>
          <HideSidebarMenu onHide={hideAutomationsButton} />
        </ContextMenu>
      ) : null}
      {showAgentsButton ? (
        <button
          type="button"
          onClick={openActivityPage}
          aria-current={activityActive ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
            activityActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <Bell
            className={cn(
              'size-4 shrink-0',
              !activityActive && 'text-worktree-sidebar-foreground/30'
            )}
            strokeWidth={activityActive ? 2.25 : 1.75}
          />
          <span className="flex-1">
            {translate('auto.components.sidebar.SidebarNav.9c95e1ce91', 'Agents')}
          </span>
          {activityUnreadCount > 0 ? (
            <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
              {activityUnreadCount}
            </span>
          ) : null}
        </button>
      ) : null}
      {showMobileButton ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => {
                mobileOnboardingBadge.dismiss()
                openMobilePage()
              }}
              aria-current={mobileActive ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
                mobileActive
                  ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
              )}
            >
              <Smartphone
                className={cn(
                  'size-4 shrink-0',
                  !mobileActive && 'text-worktree-sidebar-foreground/30'
                )}
                strokeWidth={mobileActive ? 2.25 : 1.75}
              />
              <span className="flex-1">
                {translate('auto.components.sidebar.SidebarNav.1b5c41caee', 'Orca Mobile')}
              </span>
              {mobileOnboardingBadge.visible ? (
                <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                  {translate('auto.components.sidebar.SidebarNav.c86d83b5c3', 'New')}
                </span>
              ) : null}
            </button>
          </ContextMenuTrigger>
          <HideSidebarMenu onHide={hideMobileButton} />
        </ContextMenu>
      ) : null}
      {(pinnedWebPanels ?? []).map((panel) => {
        const panelActive = activeView === 'web-panel' && activePinnedWebPanelId === panel.id
        return (
          <button
            key={panel.id}
            type="button"
            onClick={() => openPinnedWebPanelPage(panel.id)}
            aria-current={panelActive ? 'page' : undefined}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
              panelActive
                ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
            )}
          >
            <Globe
              className={cn(
                'size-4 shrink-0',
                !panelActive && 'text-worktree-sidebar-foreground/30'
              )}
              strokeWidth={panelActive ? 2.25 : 1.75}
            />
            <span className="min-w-0 flex-1 truncate">{panel.title}</span>
          </button>
        )
      })}
      {groupedTerminalPanels
        .filter((section) => section.group === null)
        .flatMap((section) =>
          section.panels.map((panel) => (
            <PinnedTerminalPanelButton
              key={panel.id}
              panel={panel}
              active={activeView === 'terminal-panel' && activePinnedTerminalPanelId === panel.id}
              onOpen={openPinnedTerminalPanelPage}
            />
          ))
        )}
      {groupedTerminalPanels.some((section) => section.group !== null) ? (
        <button
          type="button"
          onClick={() => toggleTerminalPanelGroup(PINNED_TERMINAL_PANELS_ROOT_FOLD)}
          aria-expanded={!collapsedTerminalPanelGroups.has(PINNED_TERMINAL_PANELS_ROOT_FOLD)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
            'text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80'
          )}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 transition-transform',
              !collapsedTerminalPanelGroups.has(PINNED_TERMINAL_PANELS_ROOT_FOLD) && 'rotate-90'
            )}
            strokeWidth={2}
          />
          <span className="min-w-0 flex-1 truncate">
            {translate('auto.components.sidebar.SidebarNav.pinnedPanelNodes', 'Nodes')}
          </span>
        </button>
      ) : null}
      {collapsedTerminalPanelGroups.has(PINNED_TERMINAL_PANELS_ROOT_FOLD)
        ? null
        : groupedTerminalPanels.map((section) => {
            const { group } = section
            return group === null ? null : (
              <div key={`group:${group}`}>
                <button
                  type="button"
                  onClick={() => toggleTerminalPanelGroup(group)}
                  aria-expanded={!collapsedTerminalPanelGroups.has(group)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 pl-4 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
                    // Why: a collapsed group hiding the active panel keeps accent
                    // styling so the current location stays discoverable.
                    collapsedTerminalPanelGroups.has(group) &&
                      section.panels.some(
                        (panel) =>
                          activeView === 'terminal-panel' &&
                          activePinnedTerminalPanelId === panel.id
                      )
                      ? 'text-worktree-sidebar-accent-foreground'
                      : 'text-worktree-sidebar-foreground/40 hover:text-worktree-sidebar-foreground/70'
                  )}
                >
                  <ChevronRight
                    className={cn(
                      'size-3 shrink-0 transition-transform',
                      !collapsedTerminalPanelGroups.has(group) && 'rotate-90'
                    )}
                    strokeWidth={2}
                  />
                  <span className="min-w-0 flex-1 truncate">{group}</span>
                </button>
                {!collapsedTerminalPanelGroups.has(group)
                  ? section.panels.map((panel) => (
                      <PinnedTerminalPanelButton
                        key={panel.id}
                        panel={panel}
                        nested
                        active={
                          activeView === 'terminal-panel' &&
                          activePinnedTerminalPanelId === panel.id
                        }
                        onOpen={openPinnedTerminalPanelPage}
                      />
                    ))
                  : null}
              </div>
            )
          })}
      <button
        type="button"
        onClick={() => openModal('worktree-palette')}
        aria-label={translate(
          'auto.components.sidebar.SidebarNav.0c3395fd32',
          'Search worktrees and browser tabs'
        )}
        className="group relative flex h-7 w-full items-center rounded-md border border-worktree-sidebar-border/70 bg-worktree-sidebar-foreground/5 pl-7 pr-1.5 text-left text-[12px] font-medium tracking-tight text-worktree-sidebar-foreground/45 transition-colors hover:border-worktree-sidebar-border hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-worktree-sidebar-ring/50"
      >
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-worktree-sidebar-foreground/30"
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate">
          {translate('auto.components.sidebar.SidebarNav.80611a8b10', 'Search')}
        </span>
        <span className="pointer-events-none ml-1.5 hidden shrink-0 items-center gap-1.5 group-hover:inline-flex group-focus-within:inline-flex">
          {worktreePaletteShortcutCombos.map((combo) => (
            <ShortcutKeyCombo
              key={combo.keys.join('-')}
              keys={combo.keys}
              doubleTap={combo.doubleTap}
              className="inline-flex gap-0.5"
              keyCapClassName="min-w-4 border-worktree-sidebar-border/80 bg-worktree-sidebar-foreground/8 px-1 py-px text-[9px] text-worktree-sidebar-foreground/55 shadow-none"
              separatorClassName="text-[9px] text-worktree-sidebar-foreground/45"
            />
          ))}
        </span>
      </button>
    </div>
  )
})

export default SidebarNav
