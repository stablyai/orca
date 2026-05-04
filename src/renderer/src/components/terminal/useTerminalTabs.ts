import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { useShallow } from 'zustand/react/shallow'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import {
  createNewTerminalTab,
  closeTerminalTab,
  closeOtherTerminalTabs,
  closeTerminalTabsToRight,
  activateTerminalTab,
  activateEditorFile,
  toggleTerminalPaneExpand
} from './terminal-tab-actions'

export type UnifiedTerminalItem = {
  type: 'terminal' | 'editor'
  id: string
}

export function useTerminalTabs() {
  const allWorktrees = useAllWorktrees()
  const {
    activeWorktreeId,
    activeView,
    tabsByWorktree,
    activeTabId,
    tabBarOrderByWorktree,
    setActiveTab,
    setTabCustomTitle,
    setTabColor,
    consumeSuppressedPtyExit,
    expandedPaneByTabId,
    workspaceSessionReady,
    openFiles,
    activeFileId,
    activeTabType,
    setTabBarOrder,
    closeAllFiles
  } = useAppStore(
    useShallow((s) => ({
      activeWorktreeId: s.activeWorktreeId,
      activeView: s.activeView,
      tabsByWorktree: s.tabsByWorktree,
      activeTabId: s.activeTabId,
      tabBarOrderByWorktree: s.tabBarOrderByWorktree,
      setActiveTab: s.setActiveTab,
      setTabCustomTitle: s.setTabCustomTitle,
      setTabColor: s.setTabColor,
      consumeSuppressedPtyExit: s.consumeSuppressedPtyExit,
      expandedPaneByTabId: s.expandedPaneByTabId,
      workspaceSessionReady: s.workspaceSessionReady,
      openFiles: s.openFiles,
      activeFileId: s.activeFileId,
      activeTabType: s.activeTabType,
      setTabBarOrder: s.setTabBarOrder,
      closeAllFiles: s.closeAllFiles
    }))
  )

  const tabs = useMemo(
    () => (activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, tabsByWorktree]
  )
  const worktreeFiles = useMemo(
    () => (activeWorktreeId ? openFiles.filter((f) => f.worktreeId === activeWorktreeId) : []),
    [activeWorktreeId, openFiles]
  )
  const totalTabs = tabs.length + worktreeFiles.length
  const tabBarOrder = activeWorktreeId ? tabBarOrderByWorktree[activeWorktreeId] : undefined

  const unifiedTabs = useMemo<UnifiedTerminalItem[]>(() => {
    const terminalIds = tabs.map((t) => t.id)
    const terminalIdSet = new Set(terminalIds)
    const orderedIds = reconcileTabOrder(
      tabBarOrder,
      terminalIds,
      worktreeFiles.map((f) => f.id)
    )
    return orderedIds.map((id) => ({
      type: (terminalIdSet.has(id) ? 'terminal' : 'editor') as 'terminal' | 'editor',
      id
    }))
  }, [tabs, worktreeFiles, tabBarOrder])

  const [mountedWorktreeIds, setMountedWorktreeIds] = useState<string[]>([])
  const [initialTabCreationGuard, setInitialTabCreationGuard] = useState<string | null>(null)
  const prevActiveWorktreeIdRef = useRef(activeWorktreeId)
  const prevAllWorktreesRef = useRef(allWorktrees)

  // Why: synchronize the keep-alive worktree set during render to avoid a
  // one-frame flash where a newly-activated terminal pane is unmounted.
  if (
    activeWorktreeId !== prevActiveWorktreeIdRef.current ||
    allWorktrees !== prevAllWorktreesRef.current
  ) {
    prevActiveWorktreeIdRef.current = activeWorktreeId
    prevAllWorktreesRef.current = allWorktrees
    setMountedWorktreeIds((current) => {
      const allWorktreeIds = new Set(allWorktrees.map((worktree) => worktree.id))
      const next = current.filter((id) => allWorktreeIds.has(id))
      if (activeWorktreeId && !next.includes(activeWorktreeId)) {
        next.push(activeWorktreeId)
      }
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current
      }
      return next
    })
  }

  const mountedWorktrees = allWorktrees.filter((worktree) =>
    mountedWorktreeIds.includes(worktree.id)
  )

  useEffect(() => {
    if (tabs.length === 0) {
      return
    }
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
      return
    }
    setActiveTab(tabs[0].id)
  }, [activeTabId, setActiveTab, tabs])

  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    if (!activeWorktreeId) {
      setInitialTabCreationGuard(null)
      return
    }
    // Why: skip auto-creation if terminal tabs already exist, or if editor files
    // are open for this worktree. The user may have intentionally closed all
    // terminal tabs while keeping editors open — auto-spawning a terminal would
    // be disruptive.
    if (tabs.length > 0 || worktreeFiles.length > 0) {
      if (initialTabCreationGuard === activeWorktreeId) {
        setInitialTabCreationGuard(null)
      }
      return
    }
    if (initialTabCreationGuard === activeWorktreeId) {
      return
    }

    setInitialTabCreationGuard(activeWorktreeId)
    createNewTerminalTab(activeWorktreeId)
  }, [
    activeWorktreeId,
    initialTabCreationGuard,
    tabs.length,
    worktreeFiles.length,
    workspaceSessionReady
  ])

  const handleNewTab = useCallback(() => createNewTerminalTab(activeWorktreeId), [activeWorktreeId])
  const handleNewTabWithShell = useCallback(
    (shell: string) => createNewTerminalTab(activeWorktreeId, shell),
    [activeWorktreeId]
  )

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string) => {
      if (consumeSuppressedPtyExit(ptyId)) {
        return
      }
      closeTerminalTab(tabId)
    },
    [consumeSuppressedPtyExit]
  )

  const handleCloseOthers = useCallback(
    (tabId: string) => closeOtherTerminalTabs(tabId, activeWorktreeId),
    [activeWorktreeId]
  )

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => closeTerminalTabsToRight(tabId, activeWorktreeId),
    [activeWorktreeId]
  )

  return {
    activeWorktreeId,
    activeView,
    tabsByWorktree,
    tabs,
    mountedWorktrees,
    worktreeFiles,
    totalTabs,
    unifiedTabs,
    activeTabId,
    activeFileId,
    activeTabType,
    expandedPaneByTabId,
    tabBarOrder,
    setTabBarOrder,
    setTabCustomTitle,
    setTabColor,
    closeAllFiles,
    handleNewTab,
    handleNewTabWithShell,
    handleCloseTab: closeTerminalTab,
    handlePtyExit,
    handleCloseOthers,
    handleCloseTabsToRight,
    handleActivateTab: activateTerminalTab,
    handleActivateFile: activateEditorFile,
    handleTogglePaneExpand: toggleTerminalPaneExpand
  }
}
