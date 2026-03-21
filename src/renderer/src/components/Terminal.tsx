import { useEffect, useCallback, useRef } from 'react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { useAppStore } from '../store'
import TabBar from './TabBar'
import TerminalPane from './TerminalPane'

export default function Terminal(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeView = useAppStore((s) => s.activeView)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const consumeSuppressedPtyExit = useAppStore((s) => s.consumeSuppressedPtyExit)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)

  const tabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []
  const allWorktrees = Object.values(worktreesByRepo).flat()
  const prevTabCountRef = useRef(tabs.length)

  // Ensure activeTabId is valid (adjusting state during render)
  if (tabs.length > 0 && (!activeTabId || !tabs.find((t) => t.id === activeTabId))) {
    setActiveTab(tabs[0].id)
  }

  // Track which worktrees have been activated during this app session.
  // Only mount TerminalPanes for visited worktrees to prevent mass PTY
  // spawning when restoring a session with many saved worktree tabs.
  const mountedWorktreeIdsRef = useRef(new Set<string>())
  if (activeWorktreeId) {
    mountedWorktreeIdsRef.current.add(activeWorktreeId)
  }
  const tabBarRef = useRef<HTMLDivElement>(null)
  const initialTabCreationGuardRef = useRef<string | null>(null)

  // Auto-create first tab when worktree activates
  useEffect(() => {
    if (!workspaceSessionReady) return
    if (!activeWorktreeId) {
      initialTabCreationGuardRef.current = null
      return
    }

    if (tabs.length > 0) {
      if (initialTabCreationGuardRef.current === activeWorktreeId) {
        initialTabCreationGuardRef.current = null
      }
      return
    }

    // In React StrictMode (dev), mount effects are intentionally invoked twice.
    // Track the worktree we already initialized so we only create one first tab.
    if (initialTabCreationGuardRef.current === activeWorktreeId) return
    initialTabCreationGuardRef.current = activeWorktreeId
    createTab(activeWorktreeId)
  }, [workspaceSessionReady, activeWorktreeId, tabs.length, createTab])

  // Animate tab bar height with grid transition
  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return

    const showBar = tabs.length >= 2
    if (showBar) {
      el.style.gridTemplateRows = '1fr'
    } else {
      el.style.gridTemplateRows = '0fr'
    }
    prevTabCountRef.current = tabs.length
  }, [tabs.length])

  const handleNewTab = useCallback(() => {
    if (!activeWorktreeId) return
    createTab(activeWorktreeId)
  }, [activeWorktreeId, createTab])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) return
      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      if (currentTabs.length <= 1) {
        // Last tab - deactivate worktree
        closeTab(tabId)
        setActiveWorktree(null)
        return
      }

      // If closing the active tab, switch to a neighbor
      if (tabId === useAppStore.getState().activeTabId) {
        const idx = currentTabs.findIndex((t) => t.id === tabId)
        const nextTab = currentTabs[idx + 1] ?? currentTabs[idx - 1]
        if (nextTab) setActiveTab(nextTab.id)
      }
      closeTab(tabId)
    },
    [activeWorktreeId, closeTab, setActiveTab, setActiveWorktree]
  )

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string) => {
      if (consumeSuppressedPtyExit(ptyId)) return
      handleCloseTab(tabId)
    },
    [consumeSuppressedPtyExit, handleCloseTab]
  )

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) return
      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      setActiveTab(tabId)
      for (const tab of currentTabs) {
        if (tab.id !== tabId) {
          closeTab(tab.id)
        }
      }
    },
    [activeWorktreeId, closeTab, setActiveTab]
  )

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) return
      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      const index = currentTabs.findIndex((t) => t.id === tabId)
      if (index === -1) return
      const rightTabs = currentTabs.slice(index + 1)
      for (const tab of rightTabs) {
        closeTab(tab.id)
      }
    },
    [activeWorktreeId, closeTab]
  )

  const handleTogglePaneExpand = useCallback(
    (tabId: string) => {
      setActiveTab(tabId)
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
            detail: { tabId }
          })
        )
      })
    },
    [setActiveTab]
  )

  // Keyboard shortcuts
  useEffect(() => {
    if (!activeWorktreeId) return

    const onKeyDown = (e: KeyboardEvent): void => {
      // Cmd+T - new tab
      if (e.metaKey && e.key === 't' && !e.shiftKey && !e.repeat) {
        e.preventDefault()
        handleNewTab()
        return
      }

      // Cmd+W - close active tab
      if (e.metaKey && e.key === 'w' && !e.shiftKey && !e.repeat) {
        e.preventDefault()
        const currentActiveTabId = useAppStore.getState().activeTabId
        if (currentActiveTabId) {
          handleCloseTab(currentActiveTabId)
        }
        return
      }

      // Cmd+Shift+] and Cmd+Shift+[ - switch tabs
      if (e.metaKey && e.shiftKey && (e.key === ']' || e.key === '[') && !e.repeat) {
        const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
        if (currentTabs.length > 1) {
          e.preventDefault()
          const currentId = useAppStore.getState().activeTabId
          const idx = currentTabs.findIndex((t) => t.id === currentId)
          const dir = e.key === ']' ? 1 : -1
          const next = currentTabs[(idx + dir + currentTabs.length) % currentTabs.length]
          if (next) setActiveTab(next.id)
        }
        return
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeWorktreeId, handleNewTab, handleCloseTab, setActiveTab])

  if (!activeWorktreeId) return null

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
      {/* Animated tab bar container using CSS grid for smooth height animation */}
      <div
        ref={tabBarRef}
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: tabs.length >= 2 ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            worktreeId={activeWorktreeId}
            onActivate={setActiveTab}
            onClose={handleCloseTab}
            onCloseOthers={handleCloseOthers}
            onCloseToRight={handleCloseTabsToRight}
            onReorder={reorderTabs}
            onNewTab={handleNewTab}
            onSetCustomTitle={setTabCustomTitle}
            onSetTabColor={setTabColor}
            expandedPaneByTabId={expandedPaneByTabId}
            onTogglePaneExpand={handleTogglePaneExpand}
          />
        </div>
      </div>

      {/* Terminal panes container */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {allWorktrees
          .filter((wt) => mountedWorktreeIdsRef.current.has(wt.id))
          .map((worktree) => {
            const worktreeTabs = tabsByWorktree[worktree.id] ?? []
            const isVisible = activeView !== 'settings' && worktree.id === activeWorktreeId

            return (
              <div
                key={worktree.id}
                className={isVisible ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                aria-hidden={!isVisible}
              >
                {worktreeTabs.map((tab) => (
                  <TerminalPane
                    key={tab.id}
                    tabId={tab.id}
                    worktreeId={worktree.id}
                    cwd={worktree.path}
                    isActive={isVisible && tab.id === activeTabId}
                    onPtyExit={(ptyId) => handlePtyExit(tab.id, ptyId)}
                  />
                ))}
              </div>
            )
          })}
      </div>
    </div>
  )
}
