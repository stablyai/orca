import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../store'
import { useDaemonActions } from '../shared/useDaemonActions'
import type { UnifiedSessionRow } from './resource-usage-merge-types'
import type { ResourceUsageSortOption } from './resource-usage-sort'
import {
  getResourceUsageAllWorktrees,
  getResourceUsageBrowserTabsByWorktree,
  getResourceUsageDeferredSshSessionIdsByTabId,
  getResourceUsagePtyIdsByTabId,
  getResourceUsageRepos,
  getResourceUsageRuntimePaneTitlesByTabId,
  getResourceUsageTerminalLayoutsByTabId,
  getResourceUsageTabsByWorktree
} from './resource-usage-open-slices'
import {
  resolveResourceUsageSpaceScanReady,
  type ResourceUsageSpaceScanSnapshot
} from './resource-usage-space-scan-ready'
import type { ResourceSessionBindingInputs } from './resource-session-bindings'
import { useResourceSessionInventory } from './use-resource-session-inventory'

const POLL_MS = 2_000

export function useResourceUsageFoundation() {
  const snapshot = useAppStore((state) => state.memorySnapshot)
  const memorySnapshotError = useAppStore((state) => state.memorySnapshotError)
  const fetchSnapshot = useAppStore((state) => state.fetchMemorySnapshot)
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const openModal = useAppStore((state) => state.openModal)
  const openSpacePage = useAppStore((state) => state.openSpacePage)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const activeView = useAppStore((state) => state.activeView)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const workspaceSpaceScannedAt = useAppStore(
    (state) => state.workspaceSpaceAnalysis?.scannedAt ?? null
  )
  const workspaceSpaceScanning = useAppStore((state) => state.workspaceSpaceScanning)
  const [open, setOpen] = useState(false)
  const [sortOption, setSortOption] = useState<ResourceUsageSortOption>('memory')
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set())
  const [appCollapsed, setAppCollapsed] = useState(true)
  const {
    sessionInventory,
    sessionsError,
    refreshSessions,
    clearSessionsError,
    removeSession,
    removeSessions
  } = useResourceSessionInventory(workspaceSessionReady)
  const sessions = sessionInventory.sessions
  const [killConfirm, setKillConfirm] = useState<UnifiedSessionRow | null>(null)
  const [killing, setKilling] = useState(false)
  const [spaceScanSnapshot, setSpaceScanSnapshot] = useState<ResourceUsageSpaceScanSnapshot>(
    () => ({
      ready: false,
      previousScanning: workspaceSpaceScanning,
      lastSeenScannedAt: workspaceSpaceScannedAt
    })
  )
  // Why: title and binding maps churn; the closed trigger selects stable sentinels.
  const runtimePaneTitlesByTabId = useAppStore((state) =>
    getResourceUsageRuntimePaneTitlesByTabId(state, open)
  )
  const repos = useAppStore((state) => getResourceUsageRepos(state, open))
  const allWorktrees = useAppStore((state) => getResourceUsageAllWorktrees(state, open))
  const tabsByWorktree = useAppStore((state) => getResourceUsageTabsByWorktree(state, open))
  const browserTabsByWorktree = useAppStore((state) =>
    getResourceUsageBrowserTabsByWorktree(state, open)
  )
  const ptyIdsByTabId = useAppStore((state) => getResourceUsagePtyIdsByTabId(state, open))
  const terminalLayoutsByTabId = useAppStore((state) =>
    getResourceUsageTerminalLayoutsByTabId(state, open)
  )
  const deferredSshSessionIdsByTabId = useAppStore((state) =>
    getResourceUsageDeferredSshSessionIdsByTabId(state, open)
  )
  const resourceSnapshot = snapshot
  const resourceSessionBindings = useMemo<ResourceSessionBindingInputs>(
    () => ({
      ptyIdsByTabId,
      tabsByWorktree,
      terminalLayoutsByTabId,
      deferredSshSessionIdsByTabId,
      workspaceSessionReady
    }),
    [
      ptyIdsByTabId,
      tabsByWorktree,
      terminalLayoutsByTabId,
      deferredSshSessionIdsByTabId,
      workspaceSessionReady
    ]
  )
  const popoverBodyRef = useRef<HTMLDivElement | null>(null)
  const popoverBodyFocusFrameRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()
  const cancelPopoverBodyFocusFrame = useCallback((): void => {
    if (popoverBodyFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(popoverBodyFocusFrameRef.current)
    popoverBodyFocusFrameRef.current = null
  }, [])
  const setPopoverBodyNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (!node) {
        cancelPopoverBodyFocusFrame()
      }
      popoverBodyRef.current = node
    },
    [cancelPopoverBodyFocusFrame]
  )
  const daemonActions = useDaemonActions({
    onRestartSettled: () => {
      clearSessionsError()
      void fetchSnapshot()
      void refreshSessions()
    }
  })
  const nextSpaceScanSnapshot = resolveResourceUsageSpaceScanReady({
    snapshot: spaceScanSnapshot,
    open,
    activeView,
    scannedAt: workspaceSpaceScannedAt,
    scanning: workspaceSpaceScanning
  })
  if (
    nextSpaceScanSnapshot.ready !== spaceScanSnapshot.ready ||
    nextSpaceScanSnapshot.previousScanning !== spaceScanSnapshot.previousScanning ||
    nextSpaceScanSnapshot.lastSeenScannedAt !== spaceScanSnapshot.lastSeenScannedAt
  ) {
    setSpaceScanSnapshot(nextSpaceScanSnapshot)
  }
  const spaceScanReady = nextSpaceScanSnapshot.ready

  // Why: seed RAM after session restore so the closed badge does not require a click.
  useEffect(() => {
    if (workspaceSessionReady) {
      void fetchSnapshot()
    }
  }, [workspaceSessionReady, fetchSnapshot])

  useEffect(() => {
    if (!open) {
      return
    }
    void fetchSnapshot()
    void refreshSessions()
    const memTimer = window.setInterval(() => {
      void fetchSnapshot()
    }, POLL_MS)
    return () => {
      window.clearInterval(memTimer)
    }
  }, [open, fetchSnapshot, refreshSessions])

  useEffect(() => {
    if (!open) {
      clearSessionsError()
    }
  }, [open, clearSessionsError])

  return {
    snapshot,
    memorySnapshotError,
    workspaceSessionReady,
    setActiveView,
    openModal,
    openSpacePage,
    recordFeatureInteraction,
    activeWorktreeId,
    open,
    setOpen,
    sortOption,
    setSortOption,
    collapsedRepos,
    setCollapsedRepos,
    collapsedWorktrees,
    setCollapsedWorktrees,
    appCollapsed,
    setAppCollapsed,
    sessionInventory,
    sessionsError,
    refreshSessions,
    removeSession,
    removeSessions,
    sessions,
    killConfirm,
    setKillConfirm,
    killing,
    setKilling,
    runtimePaneTitlesByTabId,
    repos,
    allWorktrees,
    tabsByWorktree,
    browserTabsByWorktree,
    resourceSnapshot,
    resourceSessionBindings,
    popoverBodyRef,
    popoverBodyFocusFrameRef,
    mountedRef,
    cancelPopoverBodyFocusFrame,
    setPopoverBodyNode,
    daemonActions,
    spaceScanReady
  }
}

export type ResourceUsageFoundation = ReturnType<typeof useResourceUsageFoundation>
