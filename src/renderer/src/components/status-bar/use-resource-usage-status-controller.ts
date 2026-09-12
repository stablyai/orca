import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../store'
import { useDaemonActions } from '../shared/useDaemonActions'
import type { UnifiedSessionRow } from './resource-usage-merge-types'
import type { ResourceSessionBindingInputs } from './resource-session-bindings'
import type { SortOption } from './resource-usage-resource-tree'
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
import { useResourceSessionInventory } from './use-resource-session-inventory'
import { useResourceUsageActions } from './use-resource-usage-actions'
import { useResourceUsageDerivedModel } from './use-resource-usage-derived-model'

const POLL_MS = 2_000

export function useResourceUsageStatusController() {
  const snapshot = useAppStore((s) => s.memorySnapshot)
  const memorySnapshotError = useAppStore((s) => s.memorySnapshotError)
  const fetchSnapshot = useAppStore((s) => s.fetchMemorySnapshot)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openModal = useAppStore((s) => s.openModal)
  const openSpacePage = useAppStore((s) => s.openSpacePage)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const workspaceSpaceScannedAt = useAppStore((s) => s.workspaceSpaceAnalysis?.scannedAt ?? null)
  const workspaceSpaceScanning = useAppStore((s) => s.workspaceSpaceScanning)

  const [open, setOpen] = useState(false)
  const [sortOption, setSortOption] = useState<SortOption>('memory')
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
  // Why: tab titles churn on every keystroke; subscribe to those maps only while open so closed badges don't rerender.
  const runtimePaneTitlesByTabId = useAppStore((s) =>
    getResourceUsageRuntimePaneTitlesByTabId(s, open)
  )
  const repos = useAppStore((s) => getResourceUsageRepos(s, open))
  const allWorktrees = useAppStore((s) => getResourceUsageAllWorktrees(s, open))
  const tabsByWorktree = useAppStore((s) => getResourceUsageTabsByWorktree(s, open))
  const browserTabsByWorktree = useAppStore((s) => getResourceUsageBrowserTabsByWorktree(s, open))
  // Why: full binding maps stay behind open sentinels so unchanged counts don't rerender the closed segment.
  const ptyIdsByTabId = useAppStore((s) => getResourceUsagePtyIdsByTabId(s, open))
  const terminalLayoutsByTabId = useAppStore((s) => getResourceUsageTerminalLayoutsByTabId(s, open))
  // Why: sessions awaiting SSH reattach are live on the remote host with no other binding.
  const deferredSshSessionIdsByTabId = useAppStore((s) =>
    getResourceUsageDeferredSshSessionIdsByTabId(s, open)
  )
  const resourceSnapshot = snapshot
  // Why: ptyIdsByTabId tracks mounted/live panes only; Resource Manager reads restored wake hints only for classification.
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

  // Why: after a kill unmounts the session, focus would fall to <body>; park a ref on the popover body to restore it stably for keyboard users.
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
      // Why: the queued post-kill focus is only valid while the popover body exists.
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

  // Why: Space scans can finish after the user closes the full page/popover; the status-bar trigger becomes the handoff point.
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
    // Why: guarded render-time state update (no ref mutation during render); React can safely retry it before commit.
    setSpaceScanSnapshot(nextSpaceScanSnapshot)
  }
  const spaceScanReady = nextSpaceScanSnapshot.ready

  // Why: seed RAM after session restore so the closed chip does not require a
  // click; the session-inventory hook independently seeds daemon PTYs.
  useEffect(() => {
    if (workspaceSessionReady) {
      void fetchSnapshot()
    }
  }, [workspaceSessionReady, fetchSnapshot])

  // Poll memory only while the popover is open. Session inventory is still
  // explicit-on-open/action/seed (not a closed interval) because full
  // listSessions can pause input with large preserved-session sets.
  useEffect(() => {
    if (!open) {
      return
    }
    void fetchSnapshot()
    void refreshSessions()
    // Why: only memory polls on an interval; session inventory is explicit on open/action since it's expensive with many terminals.
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

  const derived = useResourceUsageDerivedModel({
    open,
    resourceSnapshot,
    sessions,
    resourceSessionBindings,
    runtimePaneTitlesByTabId,
    repos,
    allWorktrees,
    browserTabsByWorktree,
    workspaceSessionReady,
    sessionCount: sessionInventory.count,
    sessionsError,
    memorySnapshotError,
    snapshot,
    spaceScanReady
  })
  const actions = useResourceUsageActions({
    setCollapsedRepos,
    setCollapsedWorktrees,
    tabsByWorktree,
    setOpen,
    setActiveView,
    openModal,
    openSpacePage,
    refreshSessions,
    removeSession,
    removeSessions,
    sessions,
    resourceSessionBindings,
    workspaceSessionReady,
    killConfirm,
    setKillConfirm,
    setKilling,
    mountedRef,
    cancelPopoverBodyFocusFrame,
    popoverBodyRef,
    popoverBodyFocusFrameRef
  })

  return {
    open,
    setOpen,
    sortOption,
    setSortOption,
    collapsedRepos,
    collapsedWorktrees,
    appCollapsed,
    setAppCollapsed,
    activeWorktreeId,
    killConfirm,
    setKillConfirm,
    killing,
    setPopoverBodyNode,
    daemonActions,
    resourceSnapshot,
    spaceScanReady,
    recordFeatureInteraction,
    ...derived,
    ...actions
  }
}
