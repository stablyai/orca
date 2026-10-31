import { useCallback, useMemo, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../store'
import { useDaemonActions } from '../shared/useDaemonActions'
import type { UnifiedSessionRow } from './resource-usage-merge-types'
import type { ResourceSessionBindingInputs } from './resource-session-bindings'
import type { SortOption } from './resource-usage-resource-tree'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  getResourceUsageAllWorktrees,
  getResourceUsageBrowserTabsByWorktree,
  getResourceUsageDeferredSshSessionIdsByTabId,
  getResourceUsageFolderWorkspaces,
  getResourceUsageProjectGroups,
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
import { useRuntimeHostResources } from './use-runtime-host-resources'
import {
  collectRuntimeResourceEnvironmentIds,
  getRuntimeHostResourceNotices,
  toRuntimeHostResourceSamples
} from './runtime-host-resources'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

import { useResourceViewVisible } from './use-resource-view-visible'
import { useResourcePtyActions } from './use-resource-pty-actions'
import { useResourceMemorySnapshot } from './use-resource-memory-snapshot'

let lastSelectedResourceTab: 'resources' | 'ptys' = 'resources'

const POLL_MS = 2_000

export function useResourceUsageStatusController() {
  const snapshot = useAppStore((s) => s.memorySnapshot)
  const memorySnapshotError = useAppStore((s) => s.memorySnapshotError)
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
  const [selectedTab, setSelectedTabState] = useState(lastSelectedResourceTab)
  const setSelectedTab = (tab: string): void => {
    if (tab !== 'resources' && tab !== 'ptys') {
      return
    }
    lastSelectedResourceTab = tab
    setSelectedTabState(tab)
  }
  const windowVisible = useResourceViewVisible()
  const resourceViewActive = windowVisible && open && selectedTab === 'resources'
  const ptyViewActive = windowVisible && open && selectedTab === 'ptys'
  const viewActive = resourceViewActive || ptyViewActive
  const fetchSnapshot = useResourceMemorySnapshot(resourceViewActive)
  const localPtyInventory = useResourceSessionInventory(workspaceSessionReady, ptyViewActive, true)
  const ptyActions = useResourcePtyActions(localPtyInventory)
  const [sortOption, setSortOption] = useState<SortOption>('memory')
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set())
  const [appCollapsed, setAppCollapsed] = useState(true)
  const {
    sessionInventory,
    observedAt: resourcesObservedAt,
    sessionsError,
    refreshSessions,
    clearSessionsError,
    removeSession,
    removeSessions
  } = useResourceSessionInventory(workspaceSessionReady, resourceViewActive)
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
    getResourceUsageRuntimePaneTitlesByTabId(s, viewActive)
  )
  const repos = useAppStore((s) => getResourceUsageRepos(s, viewActive))
  const gitWorktrees = useAppStore((s) => getResourceUsageAllWorktrees(s, viewActive))
  const folders = useAppStore((s) => getResourceUsageFolderWorkspaces(s, viewActive))
  const projectGroups = useAppStore((s) => getResourceUsageProjectGroups(s, viewActive))
  const allWorktrees = useMemo(
    () => [...gitWorktrees, ...folders.map(folderWorkspaceToWorktree)],
    [gitWorktrees, folders]
  )
  const tabsByWorktree = useAppStore((s) => getResourceUsageTabsByWorktree(s, viewActive))
  const browserTabsByWorktree = useAppStore((s) =>
    getResourceUsageBrowserTabsByWorktree(s, viewActive)
  )
  // Why: full binding maps stay behind open sentinels so unchanged counts don't rerender the closed segment.
  const ptyIdsByTabId = useAppStore((s) => getResourceUsagePtyIdsByTabId(s, viewActive))
  const terminalLayoutsByTabId = useAppStore((s) =>
    getResourceUsageTerminalLayoutsByTabId(s, viewActive)
  )
  // Why: sessions awaiting SSH reattach are live on the remote host with no other binding.
  const deferredSshSessionIdsByTabId = useAppStore((s) =>
    getResourceUsageDeferredSshSessionIdsByTabId(s, viewActive)
  )
  const resourceSnapshot = snapshot
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeEnvironmentIds = useMemo(
    () =>
      collectRuntimeResourceEnvironmentIds([
        ...repos.map(getRepoExecutionHostId),
        ...allWorktrees.map((worktree) => worktree.hostId)
      ]),
    [repos, allWorktrees]
  )
  const runtimeHostResults = useRuntimeHostResources(
    resourceViewActive,
    runtimeEnvironmentIds,
    POLL_MS
  )
  const { runtimeHostResources, runtimeHostNotices } = useMemo(() => {
    const hostLabel = (environmentId: string): string =>
      runtimeEnvironments.find((environment) => environment.id === environmentId)?.name ||
      environmentId
    return {
      runtimeHostResources: toRuntimeHostResourceSamples(runtimeHostResults, hostLabel),
      runtimeHostNotices: getRuntimeHostResourceNotices(runtimeHostResults, hostLabel)
    }
  }, [runtimeHostResults, runtimeEnvironments])
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

  const derived = useResourceUsageDerivedModel({
    open: resourceViewActive,
    resourceSnapshot,
    runtimeHostResources,
    sessions,
    resourceSessionBindings,
    runtimePaneTitlesByTabId,
    repos,
    allWorktrees,
    projectGroups,
    browserTabsByWorktree,
    workspaceSessionReady,
    sessionCount: resourcesObservedAt === null ? null : sessionInventory.count,
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
    selectedTab,
    setSelectedTab,
    ptyViewActive,
    resourceViewActive,
    localPtyInventory,
    ptyActions,
    resourceSessionBindings,
    runtimePaneTitlesByTabId,
    repos,
    projectGroups,
    allWorktrees,
    refreshResources: () => {
      void fetchSnapshot()
      void refreshSessions()
    },
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
    runtimeHostNotices,
    spaceScanReady,
    recordFeatureInteraction,
    ...derived,
    ...actions
  }
}
