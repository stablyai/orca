import { getProjectGroupingIndexFromState } from '@/store/projects/project-host-setup-selector'
import { useDeferredValue, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { buildActivityEvents } from './activity-event-builder'
import { createActivityEventBuildCache } from '@/components/activity/activity-event-build-cache'
import { freshActivityLiveAgentState, isRunningActivityState } from './activity-event-state'
import {
  useAgentPaneThreadsDefaultHostId,
  useAllAgentPaneThreadStoreData,
  type AgentPaneThreadsStoreData,
  type AllAgentPaneThreadsStoreData
} from './use-agent-pane-thread-store-data'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'
import { collectHiddenChildAgentPaneKeys } from './activity-thread-child-agent'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../../../shared/workspace-creator-visibility'
import { filterThreadsByActivityScope, resolveActivityScopeRepoIds } from './activity-scope-filter'
import {
  createActivityThreadSearchMatcher,
  buildActivityThreadGroups,
  isActivitySearchQueryTooLarge
} from './activity-thread-grouping'
import type {
  ActivityGroupBy,
  ThreadReadFilter
} from '../../../../shared/agents-view-thread-filters'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'

const EMPTY_PANE_KEYS: ReadonlySet<string> = new Set()
const EMPTY_THREADS: AgentPaneThread[] = []
const EMPTY_GROUPS: ActivityThreadGroup[] = []
const EMPTY_ACTIVITY_BUILD: ReturnType<typeof buildActivityEvents> = {
  events: [],
  liveAgentByPaneKey: {},
  paneEntryByPaneKey: {}
}

/** Every Activity thread before any view filter: store data to events and threads. */
export function useAllAgentPaneThreads({ badgeOnly = false }: { badgeOnly?: boolean } = {}): {
  storeData: AllAgentPaneThreadsStoreData
  allThreads: AgentPaneThread[]
} {
  const storeData = useAllAgentPaneThreadStoreData()
  // Why: agentStatusEpoch is a dep (not used in the body) so the memo recomputes when freshness boundaries expire even without new PTY data.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const chatNames = useStructuredChatTabNames()

  // Per-hook caches preserve unchanged pane/event/thread identities across status writes, including repeated StrictMode/deferred builds.
  const eventBuildCacheRef = useRef<ReturnType<typeof createActivityEventBuildCache>>(undefined!)
  eventBuildCacheRef.current ??= createActivityEventBuildCache()
  const threadReuseCacheRef = useRef<ReturnType<typeof createAgentPaneThreadReuseCache>>(undefined!)
  threadReuseCacheRef.current ??= createAgentPaneThreadReuseCache()

  const {
    events: allEvents,
    liveAgentByPaneKey,
    paneEntryByPaneKey
  } = useMemo(
    () => {
      const now = Date.now()
      if (
        badgeOnly &&
        Object.keys(storeData.migrationUnsupportedByPtyId).length === 0 &&
        !Object.values(storeData.agentStatusByPaneKey).some((entry) =>
          freshActivityLiveAgentState(entry, now)
        )
      ) {
        eventBuildCacheRef.current.panes.clear()
        eventBuildCacheRef.current.tabs = undefined
        return EMPTY_ACTIVITY_BUILD
      }
      // Global history caps affect live-thread unread and search state.
      return buildActivityEvents(
        {
          chatNames,
          agentStatusByPaneKey: storeData.agentStatusByPaneKey,
          runtimeAgentOrchestrationByPaneKey: storeData.runtimeAgentOrchestrationByPaneKey,
          migrationUnsupportedByPtyId: storeData.migrationUnsupportedByPtyId,
          retainedAgentsByPaneKey: storeData.retainedAgentsByPaneKey,
          tabsByWorktree: storeData.tabsByWorktree,
          ptyIdsByTabId: storeData.ptyIdsByTabId,
          unifiedTabsByWorktree: storeData.activityTabs,
          worktreeMap: storeData.worktreeMap,
          repoMap: storeData.repoMap,
          repos: storeData.repos,
          resolveWorktree: storeData.getKnownWorktreeById,
          acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
          activityClearedAtByPaneKey: storeData.activityClearedAtByPaneKey,
          // Why: Date.now() is read in the memo body (not a dep) so stale-decay recomputes when agentStatusEpoch ticks, not on wall-clock time.
          now
        },
        eventBuildCacheRef.current
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeData, agentStatusEpoch, chatNames, badgeOnly]
  )

  const allThreads = useMemo(
    () =>
      buildAgentPaneThreads(
        {
          events: badgeOnly
            ? allEvents.filter((event) => liveAgentByPaneKey[event.entry.paneKey])
            : allEvents,
          liveAgentByPaneKey,
          paneEntryByPaneKey,
          generatedTitlesEnabled: storeData.generatedTitlesEnabled
        },
        threadReuseCacheRef.current
      ),
    [allEvents, liveAgentByPaneKey, paneEntryByPaneKey, storeData.generatedTitlesEnabled, badgeOnly]
  )

  return { storeData, allThreads }
}

/** Shared Activity/sidebar pipeline: store data to events, threads, filters and groups. */
export function useAgentPaneThreads(args: {
  query: string
  readFilter: ThreadReadFilter
  groupBy: ActivityGroupBy
  selectedPaneKey: string | null
  showChildAgents?: boolean
  /** Prepare only live badge rows, omitting list groups and bulk-action sets. */
  badgeOnly?: boolean
}): {
  storeData: AgentPaneThreadsStoreData
  allThreads: AgentPaneThread[]
  selectedPaneKeyIsLive: boolean
  effectiveSelectedPaneKey: string | null
  /** Every active view filter applies here; destructive Clear completed must not touch hidden rows. */
  visibleThreads: AgentPaneThread[]
  /** Badge-coherent threads after child classification; ignore transient search/scope/read filters so Mark all read can clear the badge. */
  markAllReadThreads: AgentPaneThread[]
  visibleThreadGroups: ActivityThreadGroup[]
} {
  const {
    query,
    readFilter,
    groupBy,
    selectedPaneKey,
    showChildAgents = false,
    badgeOnly = false
  } = args
  const grouping = useAppStore(getProjectGroupingIndexFromState)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.agentsHideWorkspacesFromOtherDevices)
  const hideAutomationGeneratedWorkspaces = useAppStore(
    (s) => s.agentsHideAutomationGeneratedWorkspaces
  )
  const hideCliCreatedWorkspaces = useAppStore((s) => s.agentsHideCliCreatedWorkspaces)
  // Why gated selectors: runtime status churns, and only the other-device filter reads it.
  const runtimeEnvironments = useAppStore((s) =>
    s.agentsHideWorkspacesFromOtherDevices ? s.runtimeEnvironments : null
  )
  const runtimeStatusByEnvironmentId = useAppStore((s) =>
    s.agentsHideWorkspacesFromOtherDevices ? s.runtimeStatusByEnvironmentId : null
  )
  const pairedDeviceIdsByEnvironment = useMemo(
    () =>
      runtimeEnvironments && runtimeStatusByEnvironmentId
        ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
        : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    [runtimeEnvironments, runtimeStatusByEnvironmentId]
  )
  const { storeData: unscopedStoreData, allThreads } = useAllAgentPaneThreads({ badgeOnly })
  const defaultHostId = useAgentPaneThreadsDefaultHostId()
  const storeData = useMemo(
    () => ({ ...unscopedStoreData, defaultHostId }),
    [unscopedStoreData, defaultHostId]
  )

  const selectedPaneKeyIsLive =
    selectedPaneKey === null || allThreads.some((thread) => thread.paneKey === selectedPaneKey)
  const effectiveSelectedPaneKey = selectedPaneKeyIsLive ? selectedPaneKey : null

  // Why scope runs before the per-view filters: host/project/origin scope must stay separate
  // from unread/search narrowing.
  const { threads: scopeVisibleThreads } = useMemo(
    () =>
      filterThreadsByActivityScope({
        threads: allThreads,
        scope: {
          visibleHostIds: agentsVisibleHostIds,
          filterRepoIds: resolveActivityScopeRepoIds(agentsFilterRepoIds, storeData.repoMap),
          defaultHostId: storeData.defaultHostId,
          hideWorkspacesFromOtherDevices,
          pairedDeviceIdsByEnvironment,
          hideAutomationGeneratedWorkspaces,
          hideCliCreatedWorkspaces
        },
        exemptPaneKey: effectiveSelectedPaneKey
      }),
    [
      allThreads,
      agentsVisibleHostIds,
      agentsFilterRepoIds,
      storeData.repoMap,
      storeData.defaultHostId,
      hideWorkspacesFromOtherDevices,
      pairedDeviceIdsByEnvironment,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      effectiveSelectedPaneKey
    ]
  )

  // Classify children over all threads so scoped-out parents do not orphan workers; skip when children are shown.
  const hiddenChildAgentPaneKeys = useMemo(
    () =>
      badgeOnly || showChildAgents ? EMPTY_PANE_KEYS : collectHiddenChildAgentPaneKeys(allThreads),
    [allThreads, showChildAgents, badgeOnly]
  )

  // Defer list filtering while typed input updates at full priority.
  const deferredQuery = useDeferredValue(query)
  const visibleThreads = useMemo(() => {
    const normalizedQuery = isActivitySearchQueryTooLarge(deferredQuery)
      ? null
      : deferredQuery.trim().toLowerCase()
    const matchesSearchQuery =
      normalizedQuery === null ? null : createActivityThreadSearchMatcher(normalizedQuery)
    return scopeVisibleThreads.filter((thread) => {
      // Keep live agents and the selected row visible after marking read; migration blocks are unavailable.
      if (
        readFilter === 'unread' &&
        !thread.unread &&
        (!isRunningActivityState(thread.currentAgentState) ||
          thread.migrationUnsupportedPtyId !== undefined) &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      // Why: child agents (e.g. dispatched orchestration workers) are hidden by default to keep top-level agent views focused on root tasks; a live child always keeps its own row.
      if (
        !showChildAgents &&
        hiddenChildAgentPaneKeys.has(thread.paneKey) &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      return matchesSearchQuery !== null && matchesSearchQuery(thread)
    })
  }, [
    scopeVisibleThreads,
    readFilter,
    deferredQuery,
    effectiveSelectedPaneKey,
    showChildAgents,
    hiddenChildAgentPaneKeys
  ])

  const markAllReadThreads = useMemo(
    () =>
      badgeOnly
        ? EMPTY_THREADS
        : allThreads.filter(
            (thread) =>
              showChildAgents ||
              !hiddenChildAgentPaneKeys.has(thread.paneKey) ||
              thread.paneKey === effectiveSelectedPaneKey
          ),
    [allThreads, showChildAgents, hiddenChildAgentPaneKeys, effectiveSelectedPaneKey, badgeOnly]
  )

  const visibleThreadGroups = useMemo(
    () =>
      badgeOnly
        ? EMPTY_GROUPS
        : buildActivityThreadGroups(visibleThreads, groupBy, undefined, storeData.repos, grouping),
    [visibleThreads, groupBy, badgeOnly, grouping, storeData.repos]
  )

  return {
    storeData,
    allThreads,
    selectedPaneKeyIsLive,
    effectiveSelectedPaneKey,
    visibleThreads,
    markAllReadThreads,
    visibleThreadGroups
  }
}
