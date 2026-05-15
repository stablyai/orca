/* eslint-disable max-lines -- Why: the floating surface owns both terminal chrome and local notes tabs until the shared floating shell is extracted. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TabBar from '@/components/tab-bar/TabBar'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { Button } from '@/components/ui/button'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  ORCHESTRATION_SETUP_STATE_EVENT,
  hasOrchestrationSetupMarker,
  isOrchestrationSetupDismissed,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import { notifyProjectNotesSelectionChanged } from '@/lib/open-project-notes-tab'
import { requestProjectNotesTabClose } from '@/lib/project-notes-close-request'
import { linkRuntimeProjectNote, showRuntimeProjectNote } from '@/runtime/runtime-notes-client'
import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TerminalTab } from '../../../../shared/types'
import { FloatingTerminalOrchestrationDialog } from './FloatingTerminalOrchestrationDialog'
import ProjectNotesTabContent from '@/components/notes/ProjectNotesTabContent'
import { FloatingTerminalResizeHandles } from './FloatingTerminalResizeHandles'
import { FloatingTerminalWindowControls } from './FloatingTerminalWindowControls'
export { FloatingTerminalToggleButton } from './FloatingTerminalToggleButton'
import {
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  type FloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'
const EMPTY_TERMINAL_TABS: TerminalTab[] = []
type FloatingNotesTab = { id: string; label: string; noteId: string | null; isDirty: boolean }

type FloatingTerminalPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function FloatingTerminalPanel({
  open,
  onOpenChange
}: FloatingTerminalPanelProps): React.JSX.Element | null {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabIdByWorktree = useAppStore((s) => s.activeTabIdByWorktree)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTabForWorktree = useAppStore((s) => s.setActiveTabForWorktree)
  const setTabBarOrder = useAppStore((s) => s.setTabBarOrder)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const tabBarOrder = useAppStore((s) => s.tabBarOrderByWorktree[FLOATING_TERMINAL_WORKTREE_ID])
  const floatingTerminalCwd = useAppStore((s) => s.settings?.floatingTerminalCwd ?? '~')
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  const [cwd, setCwd] = useState<string | null>(null)
  const [bounds, setBounds] = useState(() => getDefaultFloatingTerminalBounds())
  const [maximized, setMaximized] = useState(false)
  const [orchestrationDialogOpen, setOrchestrationDialogOpen] = useState(false)
  const [showOrchestrationSetup, setShowOrchestrationSetup] = useState(
    () => !hasOrchestrationSetupMarker() && !isOrchestrationSetupDismissed()
  )
  const [notesTabs, setNotesTabs] = useState<FloatingNotesTab[]>([])
  const [activeNotesTabId, setActiveNotesTabId] = useState<string | null>(null)
  const [activeSurface, setActiveSurface] = useState<'terminal' | 'notes'>('terminal')
  const restoreBoundsRef = useRef<FloatingTerminalPanelBounds | null>(null)
  const normalizedInitialBoundsRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    left: number
    top: number
  } | null>(null)

  const tabs = tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TERMINAL_TABS
  const activeTabId = activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? tabs[0]?.id ?? null

  useEffect(() => {
    if (!open || normalizedInitialBoundsRef.current || typeof window === 'undefined') {
      return
    }
    normalizedInitialBoundsRef.current = true
    const rightGap = window.innerWidth - bounds.left - bounds.width
    if (rightGap > 160) {
      setBounds(getDefaultFloatingTerminalBounds())
    }
  }, [bounds.left, bounds.width, open])

  useEffect(() => {
    void window.api.app
      .getFloatingTerminalCwd({
        path: floatingTerminalCwd
      })
      .then(setCwd)
  }, [floatingTerminalCwd])

  useEffect(() => {
    if (!open || tabs.length > 0) {
      return
    }
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
  }, [createTab, open, setActiveTabForWorktree, tabs.length])

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [activeTabId, tabs]
  )
  const activeFloatingTabId = activeTab?.id ?? null

  useEffect(() => {
    if (!open || !activeFloatingTabId) {
      return
    }
    focusTerminalTabSurface(activeFloatingTabId)
  }, [activeFloatingTabId, open])

  const refreshOrchestrationSetupVisibility = useCallback(async (): Promise<void> => {
    if (isOrchestrationSetupDismissed()) {
      setShowOrchestrationSetup(false)
      return
    }
    if (!hasOrchestrationSetupMarker()) {
      setShowOrchestrationSetup(true)
      return
    }
    try {
      const status = await window.api.cli.getInstallStatus()
      setShowOrchestrationSetup(status.state !== 'installed')
    } catch {
      setShowOrchestrationSetup(true)
    }
  }, [])

  useEffect(() => {
    if (open) {
      void refreshOrchestrationSetupVisibility()
    }
  }, [open, refreshOrchestrationSetupVisibility])

  useEffect(() => {
    const handleSetupStateChange = (): void => {
      void refreshOrchestrationSetupVisibility()
    }
    window.addEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleSetupStateChange)
    return () => {
      window.removeEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleSetupStateChange)
    }
  }, [refreshOrchestrationSetupVisibility])

  const createFloatingTab = useCallback(() => {
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
    setActiveSurface('terminal')
    const state = useAppStore.getState()
    const currentTabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const stored = state.tabBarOrderByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const validIds = new Set(currentTabs.map((entry) => entry.id))
    const order = stored.filter((id) => validIds.has(id) && id !== tab.id)
    for (const entry of currentTabs) {
      if (entry.id !== tab.id && !order.includes(entry.id)) {
        order.push(entry.id)
      }
    }
    order.push(tab.id)
    setTabBarOrder(FLOATING_TERMINAL_WORKTREE_ID, order)
    focusTerminalTabSurface(tab.id)
  }, [createTab, setActiveTabForWorktree, setTabBarOrder])

  const closeFloatingTab = useCallback(
    (tabId: string) => {
      closeTab(tabId)
      setActiveSurface('terminal')
    },
    [closeTab]
  )

  const closeOthers = useCallback(
    (tabId: string) => {
      for (const tab of tabs) {
        if (tab.id !== tabId) {
          closeTab(tab.id)
        }
      }
    },
    [closeTab, tabs]
  )

  const closeToRight = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) {
        return
      }
      for (const tab of tabs.slice(index + 1)) {
        closeTab(tab.id)
      }
    },
    [closeTab, tabs]
  )

  const openFloatingNotesTab = useCallback(
    async (noteId?: string) => {
      if (!activeWorktreeId) {
        return
      }
      const state = useAppStore.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id === activeWorktreeId)
      const projectId =
        state.repos.find((candidate) => candidate.id === worktree?.repoId)?.id ?? worktree?.repoId
      const settings = state.settings
      let label = 'Project Notes'
      if (noteId && projectId) {
        try {
          const result = await showRuntimeProjectNote(settings, {
            projectId,
            worktreeId: activeWorktreeId,
            note: noteId
          })
          label = result.note.title
        } catch {
          label = 'Project Notes'
        }
        if (projectId) {
          await linkRuntimeProjectNote(settings, {
            projectId,
            worktreeId: activeWorktreeId,
            note: noteId,
            kind: 'active'
          })
          notifyProjectNotesSelectionChanged()
        }
      }
      const id = `floating-project-notes:${createBrowserUuid()}`
      setNotesTabs((current) => [...current, { id, label, noteId: noteId ?? null, isDirty: false }])
      setActiveNotesTabId(id)
      setActiveSurface('notes')
    },
    [activeWorktreeId]
  )

  const closeFloatingNotesTab = useCallback((tabId: string) => {
    requestProjectNotesTabClose(tabId, () => {
      setNotesTabs((current) => current.filter((tab) => tab.id !== tabId))
      setActiveNotesTabId((current) => (current === tabId ? null : current))
      setActiveSurface('terminal')
    })
  }, [])

  useEffect(() => {
    if (!open || activeSurface !== 'notes' || !activeNotesTabId) {
      return
    }
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (!mod || event.shiftKey || event.repeat || event.key.toLowerCase() !== 'w') {
        return
      }
      event.preventDefault()
      closeFloatingNotesTab(activeNotesTabId)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeNotesTabId, activeSurface, closeFloatingNotesTab, open])

  const toggleMaximized = useCallback(() => {
    setMaximized((current) => {
      if (current) {
        setBounds(restoreBoundsRef.current ?? getDefaultFloatingTerminalBounds())
        restoreBoundsRef.current = null
        return false
      }
      restoreBoundsRef.current = bounds
      setBounds(getMaximizedFloatingTerminalBounds())
      return true
    })
  }, [bounds])

  const handleDragStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (maximized) {
      return
    }
    if (event.button !== 0) {
      return
    }
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest(
        'button,input,textarea,select,[role="menuitem"],[data-testid="sortable-tab"],[data-floating-terminal-no-drag]'
      )
    ) {
      return
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: bounds.left,
      top: bounds.top
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleDragMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    setBounds((prev) =>
      clampFloatingTerminalBounds({
        ...prev,
        left: drag.left + event.clientX - drag.startX,
        top: drag.top + event.clientY - drag.startY
      })
    )
  }

  const handleDragEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }

  const dismissOrchestrationSetup = useCallback(() => {
    localStorage.setItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY, '1')
    setShowOrchestrationSetup(false)
    notifyOrchestrationSetupStateChanged()
  }, [])

  return (
    <div
      ref={panelRef}
      data-floating-terminal-panel
      aria-hidden={!open}
      className={`fixed z-50 flex min-h-[280px] min-w-[420px] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] ${open ? 'opacity-100' : 'invisible pointer-events-none opacity-0'}`}
      style={{
        visibility: open ? 'visible' : 'hidden',
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height
      }}
      onMouseUp={(event) => {
        if (maximized) {
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        setBounds((prev) =>
          clampFloatingTerminalBounds({ ...prev, width: rect.width, height: rect.height })
        )
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex h-9 shrink-0 cursor-grab items-center border-b border-border bg-[var(--bg-titlebar,var(--card))] active:cursor-grabbing"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <div className="flex h-full min-w-0 flex-1">
            <TabBar
              tabs={tabs}
              activeTabId={activeTab?.id ?? null}
              worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
              expandedPaneByTabId={expandedPaneByTabId}
              onActivate={(tabId) => {
                setActiveSurface('terminal')
                setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tabId)
              }}
              onClose={closeFloatingTab}
              onCloseOthers={closeOthers}
              onCloseToRight={closeToRight}
              onNewTerminalTab={createFloatingTab}
              onNewBrowserTab={() => {}}
              onNewNotesTab={activeWorktreeId ? openFloatingNotesTab : undefined}
              notesWorktreeId={activeWorktreeId}
              terminalOnly
              onSetCustomTitle={setTabCustomTitle}
              onSetTabColor={setTabColor}
              onTogglePaneExpand={(tabId) =>
                setTabPaneExpanded(tabId, expandedPaneByTabId[tabId] !== true)
              }
              notesTabs={activeWorktreeId ? notesTabs : []}
              activeNotesTabId={activeSurface === 'notes' ? activeNotesTabId : null}
              onActivateNotesTab={(tabId) => {
                setActiveNotesTabId(tabId)
                setActiveSurface('notes')
              }}
              onCloseNotesTab={closeFloatingNotesTab}
              activeTabType={activeSurface}
              tabBarOrder={tabBarOrder}
            />
          </div>
          <FloatingTerminalWindowControls
            maximized={maximized}
            onToggleMaximized={toggleMaximized}
            onMinimize={() => onOpenChange(false)}
          />
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
          {activeSurface === 'notes' && activeWorktreeId && activeNotesTabId ? (
            <ProjectNotesTabContent
              key={activeNotesTabId}
              worktreeId={activeWorktreeId}
              tabId={activeNotesTabId}
              noteId={notesTabs.find((tab) => tab.id === activeNotesTabId)?.noteId ?? null}
              forceNew={notesTabs.find((tab) => tab.id === activeNotesTabId)?.noteId === null}
              onDirtyChange={(dirty) => {
                setNotesTabs((current) =>
                  current.map((tab) =>
                    tab.id === activeNotesTabId ? { ...tab, isDirty: dirty } : tab
                  )
                )
              }}
            />
          ) : cwd ? (
            tabs.map((tab) => (
              <div
                key={`${tab.id}-${tab.generation ?? 0}`}
                className={
                  tab.id === activeTab?.id ? 'absolute inset-0' : 'absolute inset-0 hidden'
                }
                aria-hidden={tab.id !== activeTab?.id}
              >
                <TerminalPane
                  tabId={tab.id}
                  worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                  cwd={cwd}
                  isActive={tab.id === activeTab?.id}
                  isVisible={tab.id === activeTab?.id}
                  onPtyExit={() => closeTab(tab.id)}
                  onCloseTab={() => closeTab(tab.id)}
                />
              </div>
            ))
          ) : null}
        </div>
      </div>
      {showOrchestrationSetup ? (
        <div
          className="absolute right-4 bottom-4 z-10 w-[280px] rounded-md border border-border/60 bg-card/95 p-3 text-card-foreground shadow-xs"
          data-floating-terminal-no-drag
        >
          <div className="space-y-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable orchestration</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Set up the Orca CLI and agent skill so agents can coordinate through Orca.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex-1"
                onClick={dismissOrchestrationSetup}
              >
                Dismiss
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="flex-1"
                onClick={() => setOrchestrationDialogOpen(true)}
              >
                Enable
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {!maximized && <FloatingTerminalResizeHandles bounds={bounds} setBounds={setBounds} />}
      <FloatingTerminalOrchestrationDialog
        open={orchestrationDialogOpen}
        activeTabId={activeTab?.id ?? null}
        onOpenChange={setOrchestrationDialogOpen}
        onSetupStateChange={() => void refreshOrchestrationSetupVisibility()}
      />
    </div>
  )
}
