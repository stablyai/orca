import { useDeferredValue, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import {
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { buildActivityEvents, createActivityEventBuildCache } from './activity-event-builder'
import { projectActivityTabs, type ActivityTabProjection } from './activity-tab-projection'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'
import { collectChildAgentPaneKeys } from './activity-thread-child-agent'

const EMPTY_PANE_KEYS: ReadonlySet<string> = new Set()
import { filterThreadsByActivityScope, resolveActivityScopeRepoIds } from './activity-scope-filter'
import {
  activityThreadMatchesSearchQuery,
  buildActivityThreadGroups,
  isActivitySearchQueryTooLarge
} from './activity-thread-grouping'
import type {
  ActivityGroupBy,
  ActivityThreadGroup,
  AgentPaneThread,
  ThreadReadFilter
} from './activity-thread-types'

export type AgentPaneThreadsStoreData = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'detectedWorktreesByRepo'
  | 'getKnownWorktreeById'
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'acknowledgeAgents'
  | 'unacknowledgeAgents'
> & {
  /** Terminal and agent-session tabs only, identity-stable across focus writes. */
  activityTabs: ActivityTabProjection
  worktreeMap: ReturnType<typeof getWorktreeMapFromState>
  repoMap: ReturnType<typeof getRepoMapFromState>
  generatedTitlesEnabled: boolean
  /** Focused-host fallback for hostless worktrees, shared by the scope filter and the row actions. */
  defaultHostId: ExecutionHostId
}

/** The Activity thread pipeline (store read -> events -> threads -> filter ->
 *  groups), shared by the Activity page and the sidebar agents list. */
export function useAgentPaneThreads(args: {
  query: string
  readFilter: ThreadReadFilter
  groupBy: ActivityGroupBy
  selectedPaneKey: string | null
  showChildAgents?: boolean
}): {
  storeData: AgentPaneThreadsStoreData
  allThreads: AgentPaneThread[]
  selectedPaneKeyIsLive: boolean
  effectiveSelectedPaneKey: string | null
  /** Threads shown after every active filter; Clear completed operates on exactly
   *  this set so it never destroys rows the user cannot see. */
  visibleThreads: AgentPaneThread[]
  /** Threads after the child-agent classification only — the set the Agents-tab
   *  badge counts and Mark all read clears; transient search/scope/read narrowing
   *  is ignored so the badge is always clearable. */
  markAllReadThreads: AgentPaneThread[]
  visibleThreadGroups: ActivityThreadGroup[]
} {
  const { query, readFilter, groupBy, selectedPaneKey, showChildAgents = false } = args
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  // Why project: the unified tab map is rewritten on every tab focus; the projection keeps
  // its identity (and each tab's) unless a field this pipeline reads actually changed.
  const tabProjectionRef = useRef<{
    raw: AppState['unifiedTabsByWorktree'] | null
    projected: ActivityTabProjection | null
  }>({ raw: null, projected: null })
  const storeData = useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      activityTabs: (() => {
        const cache = tabProjectionRef.current
        if (cache.raw === s.unifiedTabsByWorktree && cache.projected) {
          return cache.projected
        }
        const projected = projectActivityTabs(s.unifiedTabsByWorktree, cache.projected)
        tabProjectionRef.current = { raw: s.unifiedTabsByWorktree, projected }
        return projected
      })(),
      repos: s.repos,
      worktreesByRepo: s.worktreesByRepo,
      folderWorkspaces: s.folderWorkspaces,
      detectedWorktreesByRepo: s.detectedWorktreesByRepo,
      getKnownWorktreeById: s.getKnownWorktreeById,
      worktreeMap: getWorktreeMapFromState(s),
      repoMap: getRepoMapFromState(s),
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      activityClearedAtByPaneKey: s.activityClearedAtByPaneKey,
      acknowledgeAgents: s.acknowledgeAgents,
      unacknowledgeAgents: s.unacknowledgeAgents,
      generatedTitlesEnabled: s.settings?.tabAutoGenerateTitle === true,
      defaultHostId: getSettingsFocusedExecutionHostId(s.settings)
    }))
  )
  // Why: agentStatusEpoch is a dep (not used in the body) so the memo recomputes when freshness boundaries expire even without new PTY data.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  // Why per-hook caches: unchanged panes keep their exact event/snapshot/thread object
  // identities across rebuilds, so a status write to one agent leaves every other row's
  // memo bail-out and cached search text intact. Rebuilds are deterministic, so a repeated
  // (StrictMode/deferred) memo invocation returns identical objects from the cache.
  const eventBuildCacheRef = useRef<ReturnType<typeof createActivityEventBuildCache>>(undefined!)
  eventBuildCacheRef.current ??= createActivityEventBuildCache()
  const threadReuseCacheRef = useRef<ReturnType<typeof createAgentPaneThreadReuseCache>>(undefined!)
  threadReuseCacheRef.current ??= createAgentPaneThreadReuseCache()

  const { events: allEvents, liveAgentByPaneKey } = useMemo(
    () =>
      buildActivityEvents(
        {
          agentStatusByPaneKey: storeData.agentStatusByPaneKey,
          runtimeAgentOrchestrationByPaneKey: storeData.runtimeAgentOrchestrationByPaneKey,
          migrationUnsupportedByPtyId: storeData.migrationUnsupportedByPtyId,
          retainedAgentsByPaneKey: storeData.retainedAgentsByPaneKey,
          tabsByWorktree: storeData.tabsByWorktree,
          unifiedTabsByWorktree: storeData.activityTabs,
          worktreeMap: storeData.worktreeMap,
          repoMap: storeData.repoMap,
          repos: storeData.repos,
          resolveWorktree: storeData.getKnownWorktreeById,
          acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
          activityClearedAtByPaneKey: storeData.activityClearedAtByPaneKey,
          // Why: Date.now() is read in the memo body (not a dep) so stale-decay recomputes when agentStatusEpoch ticks, not on wall-clock time.
          now: Date.now()
        },
        eventBuildCacheRef.current
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeData, agentStatusEpoch]
  )

  const allThreads = useMemo(
    () =>
      buildAgentPaneThreads(
        {
          events: allEvents,
          liveAgentByPaneKey,
          generatedTitlesEnabled: storeData.generatedTitlesEnabled
        },
        threadReuseCacheRef.current
      ),
    [allEvents, liveAgentByPaneKey, storeData.generatedTitlesEnabled]
  )

  const selectedPaneKeyIsLive =
    selectedPaneKey === null || allThreads.some((thread) => thread.paneKey === selectedPaneKey)
  const effectiveSelectedPaneKey = selectedPaneKeyIsLive ? selectedPaneKey : null

  // Why scope runs before the per-view filters: host/project scope must stay separate
  // from unread/search narrowing.
  const { threads: scopeVisibleThreads } = useMemo(
    () =>
      filterThreadsByActivityScope({
        threads: allThreads,
        scope: {
          visibleHostIds: agentsVisibleHostIds,
          filterRepoIds: resolveActivityScopeRepoIds(agentsFilterRepoIds, storeData.repoMap),
          defaultHostId: storeData.defaultHostId
        },
        exemptPaneKey: effectiveSelectedPaneKey
      }),
    [
      allThreads,
      agentsVisibleHostIds,
      agentsFilterRepoIds,
      storeData.repoMap,
      storeData.defaultHostId,
      effectiveSelectedPaneKey
    ]
  )

  // Why over allThreads (not the scoped list): child classification asks whether the
  // parent pane still exists at all, and a scope filter hiding the parent must not
  // reclassify its workers as orphans.
  // Skipped entirely when children are shown: nothing reads the set then.
  const childAgentPaneKeys = useMemo(
    () => (showChildAgents ? EMPTY_PANE_KEYS : collectChildAgentPaneKeys(allThreads)),
    [allThreads, showChildAgents]
  )

  // Why deferred: filtering hundreds of threads is interruptible background work; the input
  // echoes the keystroke at full priority while the list catches up on the deferred value.
  const deferredQuery = useDeferredValue(query)
  const visibleThreads = useMemo(() => {
    const normalizedQuery = isActivitySearchQueryTooLarge(deferredQuery)
      ? null
      : deferredQuery.trim().toLowerCase()
    return scopeVisibleThreads.filter((thread) => {
      // Why: keep the just-selected thread visible after auto-mark-read flips it to read, else unread-only mode makes the clicked row vanish from the list.
      if (
        readFilter === 'unread' &&
        !thread.unread &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      // Why: child agents (e.g. dispatched orchestration workers) are hidden by default to keep top-level agent views focused on root tasks.
      if (
        !showChildAgents &&
        childAgentPaneKeys.has(thread.paneKey) &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      if (normalizedQuery === null) {
        return false
      }
      return activityThreadMatchesSearchQuery({ thread, searchQuery: normalizedQuery })
    })
  }, [
    scopeVisibleThreads,
    readFilter,
    deferredQuery,
    effectiveSelectedPaneKey,
    showChildAgents,
    childAgentPaneKeys
  ])

  const markAllReadThreads = useMemo(
    () =>
      allThreads.filter(
        (thread) =>
          showChildAgents ||
          !childAgentPaneKeys.has(thread.paneKey) ||
          thread.paneKey === effectiveSelectedPaneKey
      ),
    [allThreads, showChildAgents, childAgentPaneKeys, effectiveSelectedPaneKey]
  )

  const visibleThreadGroups = useMemo(
    () => buildActivityThreadGroups(visibleThreads, groupBy),
    [visibleThreads, groupBy]
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
