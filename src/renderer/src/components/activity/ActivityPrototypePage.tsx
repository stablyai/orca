import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { ActivityScopeFilterChips } from './activity-scope-filter-controls'
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

export * from './activity-prototype-page-exports'

export default function ActivityPrototypePage(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)
  // Why: bounds auto mark-read to one acknowledgement per selected thread turn.
  const autoAcknowledgedTurnRef = useRef<string | null>(null)
  // Why store-backed: persisted preferences shared with the sidebar agents list.
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
  // Why (default width): thread cards are the primary surface; 480px lets prompts fill line-clamp-3 and keeps the per-card actions readable.
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
    // Why: rows disappear when agent retention or tab state changes; clear stale selection before detail/portal rendering targets it.
    setSelectedPaneKey(null)
  }

  const selectedThread = effectiveSelectedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === effectiveSelectedPaneKey) ?? null)
    : null
  const selectedTabId = selectedThread?.tab.id ?? null
  const selectedWorktreeAvailable = selectedThread
    ? hasActivityThreadWorkspace(selectedThread, storeData)
    : false
  // Why: repo-less terminal buckets can produce Activity rows, but the workspace Terminal tree only portals real worktrees.
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

  // Why (no flash): anchor the portal to the selected thread's ids; selectThread's multi-step store update can briefly reflect a stale "last active tab" (wrong-terminal flash).
  // Why useMemo: stable descriptor identity so subscribers keep React.memo bail-outs; inactive descriptor stages the next terminal at the same size.
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

  // Why: swap-staged makes the displayed thread selected, so this branch cannot repeat by itself.
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
      // Why: a stale selected pane must swap to the unavailable state, not leave the previous pane visible under the new row.
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

  // Why useLayoutEffect (not useEffect): publish before paint so Terminal's portal subscriber rerenders in the same commit, else the stale target flashes on screen.
  // Why no cleanup-to-null on each change: it forces the portal through null on every switch, flashing the workspace pane; null only on unmount (effect below).
  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: this publishes portal descriptors to Terminal's external portal store before paint.
  useLayoutEffect(() => {
    setActivityTerminalPortals(portalDescriptors)
  }, [portalDescriptors])

  const setActivityPageRef = useCallback((node: HTMLDivElement | null): void => {
    if (!node) {
      // Why: portal cleanup must happen only on page unmount; clearing on descriptor changes flashes the workspace pane behind the activity slot.
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

    window.addEventListener('keydown', focusActivityFilter, { capture: true })
    return () => window.removeEventListener('keydown', focusActivityFilter, { capture: true })
  }, [activePortalTargetEl, inactivePortalTargetEl])

  const {
    markThreadRead,
    markThreadUnread,
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

  const canJumpToWorkspace = useCallback(
    (thread: Parameters<typeof hasActivityThreadWorkspace>[0]) =>
      hasActivityThreadWorkspace(thread, {
        worktreesByRepo: storeData.worktreesByRepo,
        detectedWorktreesByRepo: storeData.detectedWorktreesByRepo,
        folderWorkspaces: storeData.folderWorkspaces,
        defaultHostId: storeData.defaultHostId
      }),
    [
      storeData.worktreesByRepo,
      storeData.detectedWorktreesByRepo,
      storeData.folderWorkspaces,
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
    // Why (React #185): a turn stamped ahead of this clock (SSH/remote execution host) can never
    // have its unread cleared, and each retry lands on a later millisecond, so acknowledgeAgents'
    // `prev < now` guard rewrites the ack map every time and re-enters here forever through
    // storeData. Auto-read is once per turn, not a retry.
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

  // Why (page padding): no top/horizontal padding so the page reaches the window edges; the titlebar and the right pane's title row (pt-2) supply the top spacing.
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
          canJumpToWorkspace={canJumpToWorkspace}
          isThreadListResizing={isThreadListResizing}
          onResizeStart={onResizeStart}
          scopeFilterRow={<ActivityScopeFilterChips />}
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
