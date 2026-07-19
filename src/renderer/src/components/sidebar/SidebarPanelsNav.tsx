import React from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import type { PinnedTerminalPanel } from '../../../../shared/types'
import {
  PINNED_TERMINAL_PANELS_ROOT_FOLD,
  visiblePinnedTerminalPanels
} from '../../../../shared/pinned-terminal-panels'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  PanelLayoutButton,
  SortableTerminalPanelButton,
  SortableWebPanelButton
} from './SidebarPanelRows'

function movedBefore<T extends { id: string }>(
  items: readonly T[],
  activeId: string,
  overId: string
): T[] | null {
  const from = items.findIndex((item) => item.id === activeId)
  const to = items.findIndex((item) => item.id === overId)
  if (from === -1 || to === -1 || from === to) {
    return null
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Why: the pinned web + terminal panel rails live below Projects (operator
 * order: search → projects → panels) in their own scroll region, so a fleet
 * of panels can never crowd the worktree list out of the sidebar. Rows are
 * drag-sortable with the same dnd-kit conventions as the settings list; a
 * 4px activation distance keeps plain clicks opening panels.
 */
const SidebarPanelsNav = React.memo(function SidebarPanelsNav() {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const openPinnedWebPanelPage = useAppStore((s) => s.openPinnedWebPanelPage)
  const activePinnedWebPanelId = useAppStore((s) => s.activePinnedWebPanelId)
  const pinnedWebPanels = useAppStore((s) => s.settings?.pinnedWebPanels)
  const openPinnedTerminalPanelPage = useAppStore((s) => s.openPinnedTerminalPanelPage)
  const activePinnedTerminalPanelId = useAppStore((s) => s.activePinnedTerminalPanelId)
  const pinnedTerminalPanelsSetting = useAppStore((s) => s.settings?.pinnedTerminalPanels)
  const pinnedTerminalPanelsEnabled = useAppStore(
    (s) => s.settings?.pinnedTerminalPanelsEnabled !== false
  )
  const activeView = useAppStore((s) => s.activeView)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const panelLayouts = useAppStore((s) => s.settings?.panelLayouts)
  const activePanelLayoutId = useAppStore((s) => s.activePanelLayoutId)
  const openPanelLayoutInCanvas = useAppStore((s) => s.openPanelLayoutInCanvas)
  const setActivePanelLayoutId = useAppStore((s) => s.setActivePanelLayoutId)
  const deletePanelLayout = React.useCallback(
    (layoutId: string) => {
      void updateSettings({
        panelLayouts: (panelLayouts ?? []).filter((layout) => layout.id !== layoutId)
      })
      // Why: a canvas opened from the deleted layout must not keep offering
      // "Save" against an id that no longer exists.
      if (useAppStore.getState().activePanelLayoutId === layoutId) {
        setActivePanelLayoutId(null)
      }
    },
    [panelLayouts, updateSettings, setActivePanelLayoutId]
  )
  // Why: filter in a memo, not the selector — a selector returning a fresh
  // array every call would re-render on each store update.
  const pinnedTerminalPanels = React.useMemo(
    () =>
      visiblePinnedTerminalPanels({
        pinnedTerminalPanels: pinnedTerminalPanelsSetting,
        pinnedTerminalPanelsEnabled
      }),
    [pinnedTerminalPanelsSetting, pinnedTerminalPanelsEnabled]
  )
  const collapsedGroupsSetting = useAppStore((s) => s.settings?.collapsedPinnedTerminalPanelGroups)
  const collapsedTerminalPanelGroups = React.useMemo(
    () => new Set(collapsedGroupsSetting ?? []),
    [collapsedGroupsSetting]
  )
  const toggleTerminalPanelGroup = React.useCallback(
    (group: string) => {
      const next = new Set(collapsedTerminalPanelGroups)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      void updateSettings({ collapsedPinnedTerminalPanelGroups: [...next].sort() })
    },
    [collapsedTerminalPanelGroups, updateSettings]
  )
  // Why: sections keep first-appearance order from settings; panels stay in
  // authored order inside their group so the rail mirrors the settings list.
  const groupedTerminalPanels = React.useMemo(() => {
    const sections: { group: string | null; panels: PinnedTerminalPanel[] }[] = []
    const sectionByGroup = new Map<
      string,
      { group: string | null; panels: PinnedTerminalPanel[] }
    >()
    for (const panel of pinnedTerminalPanels) {
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

  const sensors = useSensors(
    // Why: an activation distance keeps panel rows clickable — a press only
    // becomes a drag after actual movement.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id)
      const overId = event.over ? String(event.over.id) : null
      if (!overId || activeId === overId) {
        return
      }
      const webPanels = pinnedWebPanels ?? []
      if (webPanels.some((panel) => panel.id === activeId)) {
        const next = movedBefore(webPanels, activeId, overId)
        if (next) {
          void updateSettings({ pinnedWebPanels: next })
        }
        return
      }
      // Why: sidebar drags only reorder within one group — the full persisted
      // list is rebuilt with that group's members re-sequenced in place, so
      // cross-group placement (a settings concern) can't happen by accident.
      const persisted = pinnedTerminalPanelsSetting ?? []
      const groupOf = (id: string): string | null | undefined => {
        const panel = persisted.find((p) => p.id === id)
        return panel ? (panel.group ?? null) : undefined
      }
      const activeGroup = groupOf(activeId)
      if (activeGroup === undefined || activeGroup !== groupOf(overId)) {
        return
      }
      const members = persisted.filter((panel) => (panel.group ?? null) === activeGroup)
      const reordered = movedBefore(members, activeId, overId)
      if (!reordered) {
        return
      }
      let cursor = 0
      const next = persisted.map((panel) =>
        (panel.group ?? null) === activeGroup ? reordered[cursor++] : panel
      )
      void updateSettings({ pinnedTerminalPanels: next })
    },
    [pinnedWebPanels, pinnedTerminalPanelsSetting, updateSettings]
  )

  const webPanelsCollapsed = useAppStore((s) => s.settings?.pinnedWebPanelsCollapsed === true)
  const hasWebPanels = (pinnedWebPanels ?? []).length > 0
  const hasTerminalPanels = pinnedTerminalPanels.length > 0
  const hasLayouts = (panelLayouts ?? []).length > 0
  if (!hasWebPanels && !hasTerminalPanels && !hasLayouts) {
    return null
  }

  return (
    <div
      className="flex-none max-h-[45%] min-h-0 overflow-y-auto scrollbar-sleek px-2 pt-1 pb-1"
      data-contextual-tour-target="sidebar-panels"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="flex flex-col gap-0.5">
          {hasLayouts ? (
            <>
              <div className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase text-worktree-sidebar-foreground/50">
                <span className="min-w-0 flex-1 truncate">
                  {translate('auto.components.sidebar.SidebarPanelsNav.layouts', 'Layouts')}
                </span>
              </div>
              {(panelLayouts ?? []).map((layout) => (
                <PanelLayoutButton
                  key={layout.id}
                  layout={layout}
                  active={activeView === 'panel-canvas' && activePanelLayoutId === layout.id}
                  onOpen={openPanelLayoutInCanvas}
                  onDelete={deletePanelLayout}
                />
              ))}
            </>
          ) : null}
          {hasWebPanels ? (
            <button
              type="button"
              onClick={() => void updateSettings({ pinnedWebPanelsCollapsed: !webPanelsCollapsed })}
              aria-expanded={!webPanelsCollapsed}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
                // Why: a collapsed fold hiding the active panel keeps accent
                // styling so the current location stays discoverable.
                webPanelsCollapsed &&
                  (pinnedWebPanels ?? []).some(
                    (panel) => activeView === 'web-panel' && activePinnedWebPanelId === panel.id
                  )
                  ? 'text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80'
              )}
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 transition-transform',
                  !webPanelsCollapsed && 'rotate-90'
                )}
                strokeWidth={2}
              />
              <span className="min-w-0 flex-1 truncate">
                {translate(
                  'auto.components.sidebar.SidebarNav.pinnedPanelUserPanels',
                  'User Panels'
                )}
              </span>
            </button>
          ) : null}
          {webPanelsCollapsed ? null : (
            <SortableContext
              items={(pinnedWebPanels ?? []).map((panel) => panel.id)}
              strategy={verticalListSortingStrategy}
            >
              {(pinnedWebPanels ?? []).map((panel) => (
                <SortableWebPanelButton
                  key={panel.id}
                  panel={panel}
                  active={activeView === 'web-panel' && activePinnedWebPanelId === panel.id}
                  onOpen={openPinnedWebPanelPage}
                />
              ))}
            </SortableContext>
          )}
          <SortableContext
            items={groupedTerminalPanels
              .filter((section) => section.group === null)
              .flatMap((section) => section.panels.map((panel) => panel.id))}
            strategy={verticalListSortingStrategy}
          >
            {groupedTerminalPanels
              .filter((section) => section.group === null)
              .flatMap((section) =>
                section.panels.map((panel) => (
                  <SortableTerminalPanelButton
                    key={panel.id}
                    panel={panel}
                    active={
                      activeView === 'terminal-panel' && activePinnedTerminalPanelId === panel.id
                    }
                    onOpen={openPinnedTerminalPanelPage}
                  />
                ))
              )}
          </SortableContext>
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
                    {!collapsedTerminalPanelGroups.has(group) ? (
                      <SortableContext
                        items={section.panels.map((panel) => panel.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {section.panels.map((panel) => (
                          <SortableTerminalPanelButton
                            key={panel.id}
                            panel={panel}
                            nested
                            active={
                              activeView === 'terminal-panel' &&
                              activePinnedTerminalPanelId === panel.id
                            }
                            onOpen={openPinnedTerminalPanelPage}
                          />
                        ))}
                      </SortableContext>
                    ) : null}
                  </div>
                )
              })}
        </div>
      </DndContext>
    </div>
  )
})

export default SidebarPanelsNav
