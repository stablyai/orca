import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import {
  setActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'
import {
  reconcileActivityPortalThreads,
  resolveActivityPortalSwap
} from './activity-portal-thread-reconciliation'
import { useAgentPaneThreads } from './use-agent-pane-threads'
import { handleActivityFilterFocusShortcut } from './activity-filter-focus-shortcut'
import { hasActivityThreadWorkspace } from './activity-thread-actions'
import { useActivityThreadActionBindings } from './use-activity-thread-action-bindings'
import { ActivityThreadListPane } from './activity-thread-list-pane'
import { ActivityThreadDetailPane } from './activity-thread-detail-pane'
import {
  otherActivityTerminalSlot,
  useActivityTerminalLoadingLabel,
  useActivityTerminalPortalStatus
} from './activity-terminal-portal-status'
import type { ActivityTerminalPortalSlotId } from './activity-thread-types'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

export * from './activity-prototype-page-exports'

export default function ActivityPrototypePage(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)
  // Auto-acknowledge each selected thread turn once.
  const autoAcknowledgedTurnRef = useRef<string | null>(null)
  // Share persisted read-filter preference with the sidebar agent list.
  const readFilter = useAppStore((s) => s.agentsReadFilter)
  const setReadFilter = useAppStore((s) => s.setAgentsReadFilter)
  const groupBy = useAppStore((s) => s.agentsGroupBy)
  const setGroupBy = useAppStore((s) => s.setAgentsGroupBy)
  const compactMode = useAppStore((s) => s.agentsCompactMode)
  const setCompactMode = useAppStore((s) => s.setAgentsCompactMode)
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const setShowChildAgents = useAppStore((s) => s.setAgentsShowChildAgents)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const [displayedPaneKey, setDisplayedPaneKey] = useState<string | null>(null)
  const [activePortalSlotId, setActivePortalSlotId] =
    useState<ActivityTerminalPortalSlotId>('primary')
  const [primaryPortalTargetEl, setPrimaryPortalTargetEl] = useState<HTMLElement | null>(null)
  const [secondaryPortalTargetEl, setSecondaryPortalTargetEl] = useState<HTMLElement | null>(null)
  // 480px keeps thread prompts/actions readable as the primary surface.
  const [threadListWidth, setThreadListWidth] = useState(480)
  const {
    containerRef: threadListRef,
    isResizing: isThreadListResizing,
    onResizeStart
  } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: threadListWidth,
    minWidth: 320,
    maxWidth: 720,
    deltaSign: 1,
    setWidth: setThreadListWidth
  })

  const {
    storeData,
    allThreads,
    selectedPaneKeyIsLive,
    effectiveSelectedPaneKey,
    visibleThreads,
    markAllReadThreads,
    visibleThreadGroups
  } = useAgentPaneThreads({ query, readFilter, groupBy, selectedPaneKey, showChildAgents })
  if (!selectedPaneKeyIsLive) {
    // Clear vanished pane selection before detail/portal rendering targets it.
    setSelectedPaneKey(null)
  }

  const selectedThread = effectiveSelectedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === effectiveSelectedPaneKey) ?? null)
    : null
  const selectedTabId = selectedThread?.tab.id ?? null
  const selectedWorktreeAvailable = selectedThread
    ? hasActivityThreadWorkspace(selectedThread, storeData)
    : false
  // Repo-less terminal buckets can have activity rows but no workspace Terminal portal.
  const selectedHasLiveTab =
    selectedThread && selectedTabId && selectedWorktreeAvailable
      ? (storeData.tabsByWorktree[selectedThread.worktree.id] ?? []).some(
          (tab) => tab.id === selectedTabId
        )
      : false
  const displayedThread = displayedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === displayedPaneKey) ?? null)
    : null
  const displayedTabId = displayedThread?.tab.id ?? null
  const displayedWorktreeAvailable = displayedThread
    ? hasActivityThreadWorkspace(displayedThread, storeData)
    : false
  const displayedHasLiveTab =
    displayedThread && displayedTabId && displayedWorktreeAvailable
      ? (storeData.tabsByWorktree[displayedThread.worktree.id] ?? []).some(
          (tab) => tab.id === displayedTabId
        )
      : false
  const { visibleThread, stagedThread } = reconcileActivityPortalThreads({
    selectedThread,
    displayedThread,
    selectedHasLiveTab: Boolean(selectedHasLiveTab),
    displayedHasLiveTab: Boolean(displayedHasLiveTab)
  })
  const inactivePortalSlotId = otherActivityTerminalSlot(activePortalSlotId)
  const portalTargetBySlot = {
    primary: primaryPortalTargetEl,
    secondary: secondaryPortalTargetEl
  } satisfies Record<ActivityTerminalPortalSlotId, HTMLElement | null>
  const activePortalTargetEl = portalTargetBySlot[activePortalSlotId]
  const inactivePortalTargetEl = portalTargetBySlot[inactivePortalSlotId]
  const visiblePortalStatus = useActivityTerminalPortalStatus(
    activePortalTargetEl,
    visibleThread?.paneKey ?? null,
    visibleThread?.migrationUnsupportedPtyId !== undefined
  )
  const stagedPortalStatus = useActivityTerminalPortalStatus(
    inactivePortalTargetEl,
    stagedThread?.paneKey ?? null,
    stagedThread?.migrationUnsupportedPtyId !== undefined
  )
  const visiblePortalReady = visiblePortalStatus === 'ready'
  const visiblePortalUnavailable = visiblePortalStatus === 'unavailable'
  const stagedPortalReady = stagedPortalStatus === 'ready'
  const stagedPortalUnavailable = stagedPortalStatus === 'unavailable'
  const showTerminalLoadingLabel = useActivityTerminalLoadingLabel(
    Boolean(visibleThread && !stagedThread && !visiblePortalReady)
  )

  const setPrimaryPortalTarget = useCallback((target: HTMLElement | null): void => {
    setPrimaryPortalTargetEl(target)
  }, [])

  const setSecondaryPortalTarget = useCallback((target: HTMLElement | null): void => {
    setSecondaryPortalTargetEl(target)
  }, [])

  // Anchor portals to selected thread IDs to avoid stale-last-tab flashes. Memoize descriptors for subscriber bailouts and stage the next terminal at the same size.
  const portalDescriptors = useMemo(() => {
    const descriptors: ActivityTerminalPortalTarget[] = []
    if (visibleThread && activePortalTargetEl) {
      descriptors.push({
        slotId: activePortalSlotId,
        requestToken: `${activePortalSlotId}:${visibleThread.paneKey}`,
        target: activePortalTargetEl,
        worktreeId: visibleThread.worktree.id,
        tabId: visibleThread.tab.id,
        paneKey: visibleThread.paneKey,
        forceUnavailable: visibleThread.migrationUnsupportedPtyId !== undefined,
        active: true
      })
    }
    if (stagedThread && inactivePortalTargetEl) {
      descriptors.push({
        slotId: inactivePortalSlotId,
        requestToken: `${inactivePortalSlotId}:${stagedThread.paneKey}`,
        target: inactivePortalTargetEl,
        worktreeId: stagedThread.worktree.id,
        tabId: stagedThread.tab.id,
        paneKey: stagedThread.paneKey,
        forceUnavailable: stagedThread.migrationUnsupportedPtyId !== undefined,
        active: false
      })
    }
    return descriptors
  }, [
    activePortalSlotId,
    activePortalTargetEl,
    inactivePortalSlotId,
    inactivePortalTargetEl,
    stagedThread,
    visibleThread
  ])

  // A staged swap selects its displayed thread, preventing self-repetition.
  useLayoutEffect(() => {
    const swap = resolveActivityPortalSwap({
      selectedThread,
      selectedHasLiveTab: Boolean(selectedHasLiveTab),
      visibleThread,
      stagedThread,
      visiblePortalReady,
      stagedPortalReady,
      stagedPortalUnavailable
    })
    if (swap?.kind === 'clear') {
      setDisplayedPaneKey(null)
      return
    }
    if (swap?.kind === 'swap-staged') {
      // Swap stale selections to unavailable state rather than showing the previous pane under a new row.
      setActivePortalSlotId(inactivePortalSlotId)
      setDisplayedPaneKey(swap.paneKey)
      return
    }
    if (swap?.kind === 'settle-visible') {
      setDisplayedPaneKey(swap.paneKey)
    }
  }, [
    inactivePortalSlotId,
    selectedHasLiveTab,
    selectedThread,
    stagedPortalUnavailable,
    stagedPortalReady,
    stagedThread,
    visiblePortalReady,
    visibleThread
  ])

  // Publish before paint to prevent stale-target flashes. Clear only on unmount; per-change null transitions flash the workspace pane.
  useLayoutEffect(() => {
    setActivityTerminalPortals(portalDescriptors)
  }, [portalDescriptors])

  const setActivityPageRef = useCallback((node: HTMLDivElement | null): void => {
    if (!node) {
      // Clear portals only on unmount to avoid flashing behind changed descriptors.
      setActivityTerminalPortals([])
    }
  }, [])

  useEffect(() => {
    const focusActivityFilter = (event: KeyboardEvent): void => {
      handleActivityFilterFocusShortcut({
        activeElement: document.activeElement,
        event,
        input: activityFilterInputRef.current,
        terminalPortalTargets: [activePortalTargetEl, inactivePortalTargetEl]
      })
    }

    addAppKeyListener('keydown', focusActivityFilter)
    return () => removeAppKeyListener('keydown', focusActivityFilter)
  }, [activePortalTargetEl, inactivePortalTargetEl])

  const {
    markThreadRead,
    markThreadUnread,
    markThreadsRead,
    markThreadsUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead,
    hasUnreadThreads,
    hasCompletedThreads,
    handleClearCompleted
  } = useActivityThreadActionBindings({
    visibleThreads,
    markAllReadThreads,
    acknowledgeAgents: storeData.acknowledgeAgents,
    unacknowledgeAgents: storeData.unacknowledgeAgents,
    setSelectedPaneKey
  })

  const worktreesByRepo = selectWorktreesByRepo(storeData)
  const detectedWorktreesByRepo = selectDetectedWorktreesByRepo(storeData)
  const folderWorkspaces = selectFolderWorkspaces(storeData)

  const canJumpToWorkspace = useCallback(
    (thread: Parameters<typeof hasActivityThreadWorkspace>[0]) =>
      hasActivityThreadWorkspace(thread, {
        worktreesByRepo,
        detectedWorktreesByRepo,
        folderWorkspaces,
        floatingWorkspacePath: storeData.floatingWorkspacePath,
        defaultHostId: storeData.defaultHostId
      }),
    [
      worktreesByRepo,
      detectedWorktreesByRepo,
      folderWorkspaces,
      storeData.floatingWorkspacePath,
      storeData.defaultHostId
    ]
  )

  useEffect(() => {
    if (
      !selectedThread ||
      !selectedThread.unread ||
      stagedThread ||
      selectedThread.paneKey !== effectiveSelectedPaneKey
    ) {
      return
    }
    // Remote turn clocks may exceed local acknowledgement time and trigger endless store rewrites (React #185). Auto-read once per turn, never retry by unread status.
    const autoAcknowledgeKey = `${selectedThread.paneKey}:${selectedThread.latestTimestamp}`
    if (autoAcknowledgedTurnRef.current === autoAcknowledgeKey) {
      return
    }
    const selectedThreadHasDetailOnlyView =
      !selectedHasLiveTab || selectedThread.migrationUnsupportedPtyId !== undefined
    const selectedThreadIsVisibleTerminal =
      visibleThread?.paneKey === effectiveSelectedPaneKey && visiblePortalReady
    if (selectedThreadHasDetailOnlyView || selectedThreadIsVisibleTerminal) {
      autoAcknowledgedTurnRef.current = autoAcknowledgeKey
      storeData.acknowledgeAgents([selectedThread.paneKey])
    }
  }, [
    selectedHasLiveTab,
    effectiveSelectedPaneKey,
    selectedThread,
    stagedThread,
    storeData,
    visiblePortalReady,
    visibleThread
  ])

  // Page content reaches window edges; titlebars supply top spacing.
  return (
    <div ref={setActivityPageRef} className="flex h-full min-h-0 flex-col bg-background pb-3">
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityThreadListPane
          threadListRef={threadListRef}
          threadListWidth={threadListWidth}
          activityFilterInputRef={activityFilterInputRef}
          query={query}
          onQueryChange={setQuery}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          readFilter={readFilter}
          onReadFilterChange={setReadFilter}
          compactMode={compactMode}
          showChildAgents={showChildAgents}
          hasUnreadThreads={hasUnreadThreads}
          onCompactModeChange={setCompactMode}
          onShowChildAgentsChange={setShowChildAgents}
          onMarkAllThreadsRead={markAllThreadsRead}
          hasCompletedThreads={hasCompletedThreads}
          onClearCompleted={handleClearCompleted}
          visibleThreadGroups={visibleThreadGroups}
          visibleThreadCount={visibleThreads.length}
          selectedPaneKey={selectedThread?.paneKey ?? null}
          onSelectThread={selectThread}
          onJumpToWorkspace={jumpToWorkspace}
          onMarkThreadRead={markThreadRead}
          onMarkThreadUnread={markThreadUnread}
          onMarkThreadsRead={markThreadsRead}
          onMarkThreadsUnread={markThreadsUnread}
          canJumpToWorkspace={canJumpToWorkspace}
          isThreadListResizing={isThreadListResizing}
          onResizeStart={onResizeStart}
        />
        <ActivityThreadDetailPane
          selectedThread={selectedThread}
          selectedHasLiveTab={Boolean(selectedHasLiveTab)}
          selectedWorktreeAvailable={selectedWorktreeAvailable}
          visibleThread={visibleThread}
          stagedThread={stagedThread}
          activePortalSlotId={activePortalSlotId}
          setPrimaryPortalTarget={setPrimaryPortalTarget}
          setSecondaryPortalTarget={setSecondaryPortalTarget}
          visiblePortalReady={visiblePortalReady}
          visiblePortalUnavailable={visiblePortalUnavailable}
          showTerminalLoadingLabel={showTerminalLoadingLabel}
          visibleThreadCount={visibleThreads.length}
        />
      </main>
    </div>
  )
}
