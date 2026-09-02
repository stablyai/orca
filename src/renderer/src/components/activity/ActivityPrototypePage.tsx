import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import {
  setActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'
import {
  reconcileActivityPortalThreads,
  resolveActivityPortalSwap
} from './activity-portal-thread-reconciliation'
import { buildActivityEvents } from './activity-event-builder'
import { buildAgentPaneThreads } from './activity-thread-builder'
import {
  activityThreadMatchesSearchQuery,
  buildActivityThreadGroups,
  isActivitySearchQueryTooLarge
} from './activity-thread-grouping'
import { handleActivityFilterFocusShortcut } from './activity-filter-focus-shortcut'
import { createActivityThreadActions } from './activity-thread-actions'
import { ActivityThreadListPane } from './activity-thread-list-pane'
import { ActivityThreadDetailPane } from './activity-thread-detail-pane'
import {
  otherActivityTerminalSlot,
  useActivityTerminalLoadingLabel,
  useActivityTerminalPortalStatus
} from './activity-terminal-portal-status'
import type {
  ActivityGroupBy,
  ActivityTerminalPortalSlotId,
  ThreadReadFilter
} from './activity-thread-types'

export * from './activity-prototype-page-exports'

export default function ActivityPrototypePage(): React.JSX.Element {
  const [readFilter, setReadFilter] = useState<ThreadReadFilter>('all')
  const [groupBy, setGroupBy] = useState<ActivityGroupBy>('status')
  const [query, setQuery] = useState('')
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)
  // Why: bounds auto mark-read to one acknowledgement per selected thread turn.
  const autoAcknowledgedTurnRef = useRef<string | null>(null)
  const [compactMode, setCompactMode] = useState(false)
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

  const storeData = useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      worktreeMap: getWorktreeMapFromState(s),
      repoMap: getRepoMapFromState(s),
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      acknowledgeAgents: s.acknowledgeAgents,
      unacknowledgeAgents: s.unacknowledgeAgents,
      generatedTitlesEnabled: s.settings?.tabAutoGenerateTitle === true
    }))
  )
  // Why: agentStatusEpoch is a dep (not used in the body) so the memo recomputes when freshness boundaries expire even without new PTY data.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  const { events: allEvents, liveAgentByPaneKey } = useMemo(
    () =>
      buildActivityEvents({
        agentStatusByPaneKey: storeData.agentStatusByPaneKey,
        migrationUnsupportedByPtyId: storeData.migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey: storeData.retainedAgentsByPaneKey,
        tabsByWorktree: storeData.tabsByWorktree,
        worktreeMap: storeData.worktreeMap,
        repoMap: storeData.repoMap,
        acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
        // Why: Date.now() is read in the memo body (not a dep) so stale-decay recomputes when agentStatusEpoch ticks, not on wall-clock time.
        now: Date.now()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeData, agentStatusEpoch]
  )

  const allThreads = useMemo(
    () =>
      buildAgentPaneThreads({
        events: allEvents,
        liveAgentByPaneKey,
        generatedTitlesEnabled: storeData.generatedTitlesEnabled
      }),
    [allEvents, liveAgentByPaneKey, storeData.generatedTitlesEnabled]
  )
  const selectedPaneKeyIsLive =
    selectedPaneKey === null || allThreads.some((thread) => thread.paneKey === selectedPaneKey)
  const effectiveSelectedPaneKey = selectedPaneKeyIsLive ? selectedPaneKey : null
  if (!selectedPaneKeyIsLive) {
    // Why: rows disappear when agent retention or tab state changes; clear stale selection before detail/portal rendering targets it.
    setSelectedPaneKey(null)
  }

  const visibleThreads = useMemo(() => {
    const normalizedQuery = isActivitySearchQueryTooLarge(query) ? null : query.trim().toLowerCase()
    return allThreads.filter((thread) => {
      // Why: keep the just-selected thread visible after auto-mark-read flips it to read, else unread-only mode makes the clicked row vanish from the list.
      if (
        readFilter === 'unread' &&
        !thread.unread &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      if (normalizedQuery === null) {
        return false
      }
      return activityThreadMatchesSearchQuery({ thread, searchQuery: normalizedQuery })
    })
  }, [allThreads, readFilter, query, effectiveSelectedPaneKey])
  const visibleThreadGroups = useMemo(
    () => buildActivityThreadGroups(visibleThreads, groupBy),
    [visibleThreads, groupBy]
  )

  const selectedThread = effectiveSelectedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === effectiveSelectedPaneKey) ?? null)
    : null
  const selectedTabId = selectedThread?.tab.id ?? null
  // Why: repo-less terminal buckets can produce Activity rows, but the workspace Terminal tree only portals real worktrees.
  const selectedHasLiveTab =
    selectedThread && selectedTabId && storeData.worktreeMap.has(selectedThread.worktree.id)
      ? (storeData.tabsByWorktree[selectedThread.worktree.id] ?? []).some(
          (tab) => tab.id === selectedTabId
        )
      : false
  const displayedThread = displayedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === displayedPaneKey) ?? null)
    : null
  const displayedTabId = displayedThread?.tab.id ?? null
  const displayedHasLiveTab =
    displayedThread && displayedTabId && storeData.worktreeMap.has(displayedThread.worktree.id)
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

  const { hasUnreadThreads, markThreadUnread, selectThread, jumpToWorkspace, markAllThreadsRead } =
    createActivityThreadActions({
      allThreads,
      acknowledgeAgents: storeData.acknowledgeAgents,
      unacknowledgeAgents: storeData.unacknowledgeAgents,
      setSelectedPaneKey
    })

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
          hasUnreadThreads={hasUnreadThreads}
          onCompactModeChange={setCompactMode}
          onMarkAllThreadsRead={markAllThreadsRead}
          visibleThreadGroups={visibleThreadGroups}
          visibleThreadCount={visibleThreads.length}
          selectedPaneKey={selectedThread?.paneKey ?? null}
          onSelectThread={selectThread}
          onJumpToWorkspace={jumpToWorkspace}
          onMarkThreadUnread={markThreadUnread}
          canJumpToWorkspace={(thread) => storeData.worktreeMap.has(thread.worktree.id)}
          isThreadListResizing={isThreadListResizing}
          onResizeStart={onResizeStart}
        />
        <ActivityThreadDetailPane
          selectedThread={selectedThread}
          selectedHasLiveTab={Boolean(selectedHasLiveTab)}
          selectedWorktreeAvailable={Boolean(
            selectedThread && storeData.worktreeMap.has(selectedThread.worktree.id)
          )}
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
