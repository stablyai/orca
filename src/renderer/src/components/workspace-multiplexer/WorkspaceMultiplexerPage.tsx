import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { updateSplitRatio } from '@/store/slices/tabs/tabs-layout'
import { WorkspaceMultiplexerDragScope } from './WorkspaceMultiplexerDragScope'
import { WorkspaceMultiplexerEmptyState } from './WorkspaceMultiplexerEmptyState'
import { WorkspaceMultiplexerHeader } from './WorkspaceMultiplexerHeader'
import { WorkspaceMultiplexerSplitLayout } from './WorkspaceMultiplexerSplitLayout'
import { WorkspaceMultiplexerTile } from './WorkspaceMultiplexerTile'
import { setTerminalSurfacePortals } from '../activity/activity-terminal-portal'
import {
  useWorkspaceMultiplexerSplitEvents,
  useWorkspaceMultiplexerTerminalPortals
} from './use-workspace-multiplexer-terminal-portals'
import {
  buildWorkspaceMultiplexerCatalog,
  countWorkspaceMultiplexerSlotsByIdentity,
  countWorkspaceMultiplexerTerminalsByIdentity,
  findWorkspaceMultiplexerCatalogItem,
  reconcileWorkspaceMultiplexerState,
  workspaceMultiplexerOwnsTerminalTabs
} from './workspace-multiplexer-model'
import {
  activateWorkspaceMultiplexerSlot,
  insertWorkspaceMultiplexerSlot
} from './workspace-multiplexer-layout'
import { useWorkspaceMultiplexerDrag } from './use-workspace-multiplexer-drag'
import { useWorkspaceMultiplexerPageActions } from './use-workspace-multiplexer-page-actions'

export default function WorkspaceMultiplexerPage(): React.JSX.Element {
  const store = useAppStore(
    useShallow((state) => ({
      multiplexer: state.workspaceMultiplexer,
      repos: state.repos,
      worktrees: getAllWorktreesFromState(state),
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      groupsByWorktree: state.groupsByWorktree,
      unifiedTabsByWorktree: state.unifiedTabsByWorktree,
      terminalTabsByWorktree: state.tabsByWorktree,
      restoredSessionHosts: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      workspaceSessionReady: state.workspaceSessionReady,
      setWorkspaceMultiplexer: state.setWorkspaceMultiplexer,
      closeWorkspaceMultiplexer: state.closeWorkspaceMultiplexer
    }))
  )
  const baseCatalog = useMemo(
    () =>
      buildWorkspaceMultiplexerCatalog({
        worktrees: store.worktrees,
        folderWorkspaces: store.folderWorkspaces,
        repos: store.repos,
        projectGroups: store.projectGroups
      }),
    [store.folderWorkspaces, store.projectGroups, store.repos, store.worktrees]
  )
  const catalogOwnershipKey = baseCatalog
    .map((workspace) =>
      workspaceMultiplexerOwnsTerminalTabs(
        workspace,
        store.unifiedTabsByWorktree[workspace.worktreeId] ?? [],
        store.restoredSessionHosts[workspace.worktreeId]
      )
        ? '1'
        : '0'
    )
    .join('')
  const catalog = useMemo(
    () => baseCatalog.filter((_, index) => catalogOwnershipKey[index] === '1'),
    [baseCatalog, catalogOwnershipKey]
  )
  const {
    focusedSlotId,
    setFocusedSlotId,
    expandedPaneId,
    setExpandedPaneId,
    focusSlot,
    focusWorkspaceSlot,
    addWorkspace,
    removeWorkspace
  } = useWorkspaceMultiplexerPageActions(catalog)
  const pageElementRef = useRef<HTMLDivElement | null>(null)
  const setPageElement = useCallback((element: HTMLDivElement | null) => {
    pageElementRef.current = element
    if (!element) {
      setTerminalSurfacePortals([])
    }
  }, [])
  const {
    groupsByWorktree,
    multiplexer,
    setWorkspaceMultiplexer,
    unifiedTabsByWorktree,
    workspaceSessionReady
  } = store

  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    const reconciled = reconcileWorkspaceMultiplexerState(
      multiplexer,
      groupsByWorktree,
      unifiedTabsByWorktree,
      catalog
    )
    if (reconciled !== multiplexer) {
      setWorkspaceMultiplexer(reconciled)
    }
  }, [
    catalog,
    groupsByWorktree,
    multiplexer,
    setWorkspaceMultiplexer,
    unifiedTabsByWorktree,
    workspaceSessionReady
  ])

  const focusTarget =
    store.multiplexer.slots.find((slot) => slot.id === focusedSlotId) ??
    store.multiplexer.slots[0] ??
    null
  const focusTargetWorkspace = focusTarget
    ? findWorkspaceMultiplexerCatalogItem(catalog, focusTarget)
    : null
  const focusTargetRef = useRef({ slot: focusTarget, workspace: focusTargetWorkspace })
  focusTargetRef.current = { slot: focusTarget, workspace: focusTargetWorkspace }
  // Why: re-focus only when the target's routing changes; every activation stamps lastFocusedAt and persists, so a catalog refresh must not re-run it.
  const focusTargetKey = focusTarget
    ? [
        focusTarget.id,
        focusTarget.groupId,
        focusTarget.activeTerminalTabId,
        focusTargetWorkspace?.identity ?? null
      ].join('\u0000')
    : null
  useEffect(() => {
    const { slot, workspace } = focusTargetRef.current
    if (slot) {
      focusSlot(slot, workspace)
      return
    }
    setFocusedSlotId(null)
    setExpandedPaneId(null)
  }, [focusSlot, focusTargetKey, setExpandedPaneId, setFocusedSlotId])

  useEffect(() => {
    if (!store.workspaceSessionReady) {
      return
    }
    for (const slot of store.multiplexer.slots) {
      if (
        findWorkspaceMultiplexerCatalogItem(catalog, slot) &&
        !(store.groupsByWorktree[slot.worktreeId]?.length > 0)
      ) {
        useAppStore.getState().ensureWorktreeRootGroup(slot.worktreeId)
      }
    }
  }, [catalog, store.multiplexer.slots, store.groupsByWorktree, store.workspaceSessionReady])

  const setPortalTarget = useWorkspaceMultiplexerTerminalPortals({
    slots: store.multiplexer.slots,
    focusedSlotId,
    catalog,
    unifiedTabsByWorktree: store.unifiedTabsByWorktree,
    restoredSessionHosts: store.restoredSessionHosts,
    terminalTabsByWorktree: store.terminalTabsByWorktree
  })

  useEffect(() => {
    if (!expandedPaneId) {
      return
    }
    const restoreLayout = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || hasVisibleOverlay()) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setExpandedPaneId(null)
    }
    window.addEventListener('keydown', restoreLayout, { capture: true })
    return () => window.removeEventListener('keydown', restoreLayout, { capture: true })
  }, [expandedPaneId, setExpandedPaneId])

  useWorkspaceMultiplexerSplitEvents(setFocusedSlotId, catalog)

  const slotCountByIdentity = useMemo(
    () => countWorkspaceMultiplexerSlotsByIdentity(store.multiplexer.slots),
    [store.multiplexer.slots]
  )
  const terminalCountByIdentity = useMemo(
    () => countWorkspaceMultiplexerTerminalsByIdentity(catalog, store.terminalTabsByWorktree),
    [catalog, store.terminalTabsByWorktree]
  )
  const focusedSlot = store.multiplexer.slots.find((slot) => slot.id === focusedSlotId) ?? null
  const multiplexerDrag = useWorkspaceMultiplexerDrag(addWorkspace, pageElementRef)
  return (
    <div
      ref={setPageElement}
      className="flex h-full min-h-0 flex-col bg-background"
      data-workspace-multiplexer-page=""
      data-workspace-multiplexer-drag-over={
        multiplexerDrag.dropTargetSlotId !== undefined ? '' : undefined
      }
    >
      <WorkspaceMultiplexerHeader
        items={catalog}
        slotCountByIdentity={slotCountByIdentity}
        terminalCountByIdentity={terminalCountByIdentity}
        onBack={store.closeWorkspaceMultiplexer}
        onSelect={addWorkspace}
        onWorkspaceDragStart={multiplexerDrag.startWorkspaceDrag}
        onWorkspaceDragEnd={multiplexerDrag.clear}
        isDragOver={multiplexerDrag.dropTargetSlotId !== undefined}
      />
      {store.multiplexer.layout && store.multiplexer.slots.length > 0 ? (
        <WorkspaceMultiplexerDragScope
          worktreeId={focusedSlot?.worktreeId ?? ''}
          onWorkspaceDrop={focusWorkspaceSlot}
        >
          {(drag) => (
            <WorkspaceMultiplexerSplitLayout
              layout={store.multiplexer.layout!}
              expandedPaneId={expandedPaneId}
              onRatioChange={(path, ratio) => {
                const state = useAppStore.getState()
                const multiplexer = state.workspaceMultiplexer
                state.setWorkspaceMultiplexer({
                  ...multiplexer,
                  layout: multiplexer.layout
                    ? updateSplitRatio(multiplexer.layout, path, ratio)
                    : null
                })
              }}
              renderPane={(paneId) => {
                const pane = store.multiplexer.panes.find((candidate) => candidate.id === paneId)
                const slot = store.multiplexer.slots.find(
                  (candidate) => candidate.id === pane?.activeSlotId
                )
                if (!pane || !slot) {
                  return null
                }
                const workspace = findWorkspaceMultiplexerCatalogItem(catalog, slot)
                const tabs = pane.slotOrder.flatMap((tabSlotId) => {
                  const tabSlot = store.multiplexer.slots.find(
                    (candidate) => candidate.id === tabSlotId
                  )
                  return tabSlot
                    ? [
                        {
                          slot: tabSlot,
                          workspace: findWorkspaceMultiplexerCatalogItem(catalog, tabSlot)
                        }
                      ]
                    : []
                })
                const groupAvailable = Boolean(
                  slot.groupId &&
                  (store.groupsByWorktree[slot.worktreeId] ?? []).some(
                    (group) => group.id === slot.groupId
                  )
                )
                return (
                  <WorkspaceMultiplexerTile
                    key={pane.id}
                    pane={pane}
                    tabs={tabs}
                    slot={slot}
                    workspace={workspace}
                    groupAvailable={groupAvailable}
                    isFocused={slot.id === focusedSlotId}
                    isExpanded={pane.id === expandedPaneId}
                    isWorkspaceDropTarget={multiplexerDrag.dropTargetSlotId === slot.id}
                    hoveredWorkspaceDropTarget={drag.hoveredWorkspaceDropTarget}
                    isTabDragActive={drag.activeDrag !== null}
                    hoveredTabInsertion={
                      drag.hoveredTabInsertion?.groupId === slot.groupId
                        ? drag.hoveredTabInsertion
                        : null
                    }
                    onFocus={() => focusSlot(slot, workspace)}
                    onSelectWorkspace={(selectedSlotId) => {
                      const selectedSlot = store.multiplexer.slots.find(
                        (candidate) => candidate.id === selectedSlotId
                      )
                      if (!selectedSlot) {
                        return
                      }
                      store.setWorkspaceMultiplexer(
                        activateWorkspaceMultiplexerSlot(store.multiplexer, pane.id, selectedSlotId)
                      )
                      focusSlot(
                        selectedSlot,
                        findWorkspaceMultiplexerCatalogItem(catalog, selectedSlot)
                      )
                    }}
                    onRemoveWorkspace={removeWorkspace}
                    onSelectTerminal={(activeTerminalTabId) =>
                      store.setWorkspaceMultiplexer({
                        ...store.multiplexer,
                        slots: store.multiplexer.slots.map((candidate) =>
                          candidate.id === slot.id
                            ? { ...candidate, activeTerminalTabId }
                            : candidate
                        )
                      })
                    }
                    onPortalTarget={setPortalTarget}
                    onSplit={(direction) => {
                      if (!focusSlot(slot, workspace) || !slot.groupId) {
                        return
                      }
                      const state = useAppStore.getState()
                      const groupId = state.createEmptySplitGroup(
                        slot.worktreeId,
                        slot.groupId,
                        direction
                      )
                      if (!groupId) {
                        return
                      }
                      const nextSlot = {
                        ...slot,
                        id: createBrowserUuid(),
                        groupId,
                        activeTerminalTabId: null
                      }
                      state.setWorkspaceMultiplexer(
                        insertWorkspaceMultiplexerSlot(
                          state.workspaceMultiplexer,
                          nextSlot,
                          slot.id,
                          direction
                        )
                      )
                      setFocusedSlotId(nextSlot.id)
                      void state.openNewTerminalTabInActiveWorkspace(groupId)
                    }}
                    onToggleExpanded={() =>
                      setExpandedPaneId((current) => (current === pane.id ? null : pane.id))
                    }
                    onNewTerminal={() => {
                      if (focusSlot(slot, workspace) && slot.groupId) {
                        void useAppStore
                          .getState()
                          .openNewTerminalTabInActiveWorkspace(slot.groupId)
                      }
                    }}
                    onWorkspaceMove={drag.moveWorkspaceSlot}
                  />
                )
              }}
            />
          )}
        </WorkspaceMultiplexerDragScope>
      ) : (
        <WorkspaceMultiplexerEmptyState
          items={catalog}
          slotCountByIdentity={slotCountByIdentity}
          terminalCountByIdentity={terminalCountByIdentity}
          onSelect={addWorkspace}
          onWorkspaceDragStart={multiplexerDrag.startWorkspaceDrag}
          onWorkspaceDragEnd={multiplexerDrag.clear}
        />
      )}
    </div>
  )
}
