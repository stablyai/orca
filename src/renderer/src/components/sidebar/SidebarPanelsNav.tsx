import React from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronRight, FolderPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import {
  PINNED_TERMINAL_PANELS_ROOT_FOLD,
  visiblePinnedTerminalPanels
} from '../../../../shared/pinned-terminal-panels'
import {
  childrenOfGroup,
  createPanelTreeGroup,
  deletePanelTreeGroup,
  movePanelInTree,
  PANEL_TREE_ROOT_NODES,
  panelsInGroup,
  renamePanelTreeGroup
} from '../../../../shared/panel-tree'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { SortableTerminalPanelButton, SortableWebPanelButton } from './SidebarPanelRows'
import {
  QuickAddCanvasForm,
  QuickAddCanvasPanelButton,
  QuickAddTerminalForm,
  QuickAddTerminalPanelButton,
  QuickAddWebForm,
  QuickAddWebPanelButton
} from './QuickAddPanelPopovers'
import { NodeGroupBranch } from './SidebarNodeGroupBranch'
import { SidebarPanelCanvasSection } from './SidebarPanelCanvasSection'
import { usePanelTreeMigrations } from './use-panel-tree-migrations'

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
  // Why: forms mount only after + click — rail buttons stay free of
  // useAppStore/Popover (React #185 at packaged boot).
  const [webQuickAddOpen, setWebQuickAddOpen] = React.useState(false)
  const [canvasQuickAddOpen, setCanvasQuickAddOpen] = React.useState(false)
  const [terminalQuickAddOpen, setTerminalQuickAddOpen] = React.useState(false)
  const openPinnedWebPanelPage = useAppStore((s) => s.openPinnedWebPanelPage)
  const activePinnedWebPanelId = useAppStore((s) => s.activePinnedWebPanelId)
  const pinnedWebPanels = useAppStore((s) => s.settings?.pinnedWebPanels)
  const openPinnedCanvasPanelPage = useAppStore((s) => s.openPinnedCanvasPanelPage)
  const activePinnedCanvasPanelId = useAppStore((s) => s.activePinnedCanvasPanelId)
  const pinnedCanvasPanels = useAppStore((s) => s.settings?.pinnedCanvasPanels)
  const canvasPanelsCollapsed = useAppStore((s) => s.settings?.pinnedCanvasPanelsCollapsed === true)
  const openPinnedTerminalPanelPage = useAppStore((s) => s.openPinnedTerminalPanelPage)
  const activePinnedTerminalPanelId = useAppStore((s) => s.activePinnedTerminalPanelId)
  const pinnedTerminalPanelsSetting = useAppStore((s) => s.settings?.pinnedTerminalPanels)
  const pinnedTerminalPanelsEnabled = useAppStore(
    (s) => s.settings?.pinnedTerminalPanelsEnabled !== false
  )
  const activeView = useAppStore((s) => s.activeView)
  const updateSettings = useAppStore((s) => s.updateSettings)
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
  const panelTreeGroups = useAppStore((s) => s.settings?.panelTreeGroups)
  const collapsedGroupsSetting = useAppStore((s) => s.settings?.collapsedPinnedTerminalPanelGroups)
  const collapsedTerminalPanelGroups = React.useMemo(
    () => new Set(collapsedGroupsSetting ?? []),
    [collapsedGroupsSetting]
  )
  const toggleTerminalPanelGroup = React.useCallback(
    (groupKey: string) => {
      const next = new Set(collapsedTerminalPanelGroups)
      if (next.has(groupKey)) {
        next.delete(groupKey)
      } else {
        next.add(groupKey)
      }
      void updateSettings({ collapsedPinnedTerminalPanelGroups: [...next].sort() })
    },
    [collapsedTerminalPanelGroups, updateSettings]
  )

  usePanelTreeMigrations({
    panelTreeGroups,
    pinnedTerminalPanels: pinnedTerminalPanelsSetting,
    pinnedWebPanels,
    collapsedGroups: collapsedGroupsSetting,
    updateSettings
  })

  const nodeGroups = React.useMemo(
    () => (panelTreeGroups ?? []).filter((g) => g.root === PANEL_TREE_ROOT_NODES),
    [panelTreeGroups]
  )
  const topLevelNodeGroups = React.useMemo(
    () => childrenOfGroup(nodeGroups, PANEL_TREE_ROOT_NODES, null),
    [nodeGroups]
  )
  const ungroupedTerminals = React.useMemo(
    () => panelsInGroup(pinnedTerminalPanels, null),
    [pinnedTerminalPanels]
  )

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
        const overWeb = webPanels.find((p) => p.id === overId)
        if (!overWeb) {
          return
        }
        const next = movePanelInTree(webPanels, activeId, overId, overWeb.groupId ?? null)
        void updateSettings({ pinnedWebPanels: next })
        return
      }
      // Why: terminal panels may move across groups (full tree reorg) — process
      // identity is untouched (L0 only).
      const persisted = pinnedTerminalPanelsSetting ?? []
      const overPanel = persisted.find((p) => p.id === overId)
      if (!overPanel) {
        // Drop onto a group header id: group:<id>
        if (overId.startsWith('group:')) {
          const groupId = overId.slice('group:'.length)
          const target = persisted.find((p) => p.groupId === groupId) ?? persisted[0]
          if (!target) {
            const solo = persisted.map((p) => (p.id === activeId ? { ...p, groupId, order: 0 } : p))
            void updateSettings({ pinnedTerminalPanels: solo })
            return
          }
          const next = movePanelInTree(persisted, activeId, target.id, groupId)
          void updateSettings({ pinnedTerminalPanels: next })
        }
        return
      }
      const next = movePanelInTree(persisted, activeId, overId, overPanel.groupId ?? null)
      void updateSettings({ pinnedTerminalPanels: next })
    },
    [pinnedWebPanels, pinnedTerminalPanelsSetting, updateSettings]
  )

  const addNodeGroup = React.useCallback(() => {
    const next = createPanelTreeGroup({
      groups: panelTreeGroups ?? [],
      root: PANEL_TREE_ROOT_NODES,
      title: translate('auto.components.sidebar.SidebarPanelsNav.newGroup', 'New group')
    })
    void updateSettings({ panelTreeGroups: next })
  }, [panelTreeGroups, updateSettings])

  const webPanelsCollapsed = useAppStore((s) => s.settings?.pinnedWebPanelsCollapsed === true)
  const hasWebPanels = (pinnedWebPanels ?? []).length > 0
  const hasCanvasPanels = (pinnedCanvasPanels ?? []).length > 0
  const hasTerminalPanels = pinnedTerminalPanels.length > 0
  const hasGroupedTerminals = topLevelNodeGroups.length > 0
  // Why: always mount the rails so User Panels / Nodes + buttons exist even
  // with zero panels (quick-add without Settings). Layouts still optional.

  return (
    <div
      className="flex-none max-h-[45%] min-h-0 overflow-y-auto scrollbar-sleek px-2 pt-1 pb-1"
      data-contextual-tour-target="sidebar-panels"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="flex flex-col gap-0.5">
          <SidebarPanelCanvasSection />
          <div className="flex w-full items-center gap-0.5">
            <button
              type="button"
              onClick={() =>
                void updateSettings({ pinnedCanvasPanelsCollapsed: !canvasPanelsCollapsed })
              }
              aria-expanded={!canvasPanelsCollapsed}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
                canvasPanelsCollapsed &&
                  (pinnedCanvasPanels ?? []).some(
                    (panel) =>
                      activeView === 'canvas-panel' && activePinnedCanvasPanelId === panel.id
                  )
                  ? 'text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80'
              )}
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 transition-transform',
                  !canvasPanelsCollapsed && 'rotate-90'
                )}
                strokeWidth={2}
              />
              <span className="min-w-0 flex-1 truncate">Collab Boards</span>
            </button>
            <QuickAddCanvasPanelButton
              open={canvasQuickAddOpen}
              onOpenChange={setCanvasQuickAddOpen}
            />
          </div>
          {canvasQuickAddOpen ? (
            <QuickAddCanvasForm onDone={() => setCanvasQuickAddOpen(false)} />
          ) : null}
          {canvasPanelsCollapsed ? null : hasCanvasPanels ? (
            (pinnedCanvasPanels ?? []).map((panel) => (
              <button
                key={panel.id}
                type="button"
                onClick={() => openPinnedCanvasPanelPage(panel.id)}
                aria-current={
                  activeView === 'canvas-panel' && activePinnedCanvasPanelId === panel.id
                    ? 'page'
                    : undefined
                }
                className={cn(
                  'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-left text-[13px] font-medium tracking-tight transition-colors',
                  activeView === 'canvas-panel' && activePinnedCanvasPanelId === panel.id
                    ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                    : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{panel.title}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1 pl-8 text-[11px] text-worktree-sidebar-foreground/35">
              Add a whiteboard with +
            </p>
          )}
          <div className="flex w-full items-center gap-0.5">
            <button
              type="button"
              onClick={() => void updateSettings({ pinnedWebPanelsCollapsed: !webPanelsCollapsed })}
              aria-expanded={!webPanelsCollapsed}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
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
            <QuickAddWebPanelButton open={webQuickAddOpen} onOpenChange={setWebQuickAddOpen} />
          </div>
          {webQuickAddOpen ? <QuickAddWebForm onDone={() => setWebQuickAddOpen(false)} /> : null}
          {webPanelsCollapsed ? null : hasWebPanels ? (
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
          ) : (
            <p className="px-2 py-1 pl-8 text-[11px] text-worktree-sidebar-foreground/35">
              {translate(
                'auto.components.sidebar.SidebarPanelsNav.emptyUserPanels',
                'Pin a dashboard with +'
              )}
            </p>
          )}
          <div className="flex w-full items-center gap-0.5">
            <button
              type="button"
              onClick={() => toggleTerminalPanelGroup(PINNED_TERMINAL_PANELS_ROOT_FOLD)}
              aria-expanded={!collapsedTerminalPanelGroups.has(PINNED_TERMINAL_PANELS_ROOT_FOLD)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
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
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0 text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80"
              aria-label={translate(
                'auto.components.sidebar.SidebarPanelsNav.newGroup',
                'New group'
              )}
              onClick={addNodeGroup}
            >
              <FolderPlus className="size-3.5" strokeWidth={2.25} />
            </Button>
            <QuickAddTerminalPanelButton
              open={terminalQuickAddOpen}
              onOpenChange={setTerminalQuickAddOpen}
            />
          </div>
          {terminalQuickAddOpen ? (
            <QuickAddTerminalForm onDone={() => setTerminalQuickAddOpen(false)} />
          ) : null}
          {collapsedTerminalPanelGroups.has(PINNED_TERMINAL_PANELS_ROOT_FOLD) ? null : (
            <>
              {!hasTerminalPanels && !hasGroupedTerminals ? (
                <p className="px-2 py-1 pl-8 text-[11px] text-worktree-sidebar-foreground/35">
                  {translate(
                    'auto.components.sidebar.SidebarPanelsNav.emptyNodes',
                    'Add an observability terminal with +'
                  )}
                </p>
              ) : null}
              <SortableContext
                items={ungroupedTerminals.map((panel) => panel.id)}
                strategy={verticalListSortingStrategy}
              >
                {ungroupedTerminals.map((panel) => (
                  <SortableTerminalPanelButton
                    key={panel.id}
                    panel={panel}
                    active={
                      activeView === 'terminal-panel' && activePinnedTerminalPanelId === panel.id
                    }
                    onOpen={openPinnedTerminalPanelPage}
                  />
                ))}
              </SortableContext>
              {topLevelNodeGroups.map((group) => (
                <NodeGroupBranch
                  key={group.id}
                  group={group}
                  allGroups={nodeGroups}
                  panels={pinnedTerminalPanels}
                  depth={0}
                  collapsedKeys={collapsedTerminalPanelGroups}
                  activeView={activeView}
                  activePanelId={activePinnedTerminalPanelId}
                  onToggle={toggleTerminalPanelGroup}
                  onOpen={openPinnedTerminalPanelPage}
                  onRename={(groupId, title) => {
                    void updateSettings({
                      panelTreeGroups: renamePanelTreeGroup(panelTreeGroups ?? [], groupId, title)
                    })
                  }}
                  onDelete={(groupId) => {
                    const result = deletePanelTreeGroup({
                      groups: panelTreeGroups ?? [],
                      groupId,
                      terminalPanels: pinnedTerminalPanelsSetting ?? [],
                      webPanels: pinnedWebPanels ?? []
                    })
                    void updateSettings({
                      panelTreeGroups: result.groups,
                      pinnedTerminalPanels: result.terminalPanels,
                      pinnedWebPanels: result.webPanels
                    })
                  }}
                  onAddChild={(parentId) => {
                    void updateSettings({
                      panelTreeGroups: createPanelTreeGroup({
                        groups: panelTreeGroups ?? [],
                        root: PANEL_TREE_ROOT_NODES,
                        title: translate(
                          'auto.components.sidebar.SidebarPanelsNav.newGroup',
                          'New group'
                        ),
                        parentId
                      })
                    })
                  }}
                />
              ))}
            </>
          )}
        </div>
      </DndContext>
    </div>
  )
})

export default SidebarPanelsNav
