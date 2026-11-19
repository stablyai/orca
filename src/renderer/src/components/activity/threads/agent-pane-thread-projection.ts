import { useCallback, useSyncExternalStore } from 'react'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getStructuredChatTabNames,
  subscribeStructuredChatTabNames
} from '@/runtime/native-chat/naming/structured-chat-name-observation'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { buildActivityEvents } from '../events/activity-event-builder'
import { createActivityEventBuildCache } from '../events/activity-event-build-cache'
import { freshActivityLiveAgentState } from '../events/activity-event-state'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'
import {
  selectAllAgentPaneThreadStoreData,
  type ActivityTabProjectionCache,
  type AllAgentPaneThreadsStoreData
} from './use-agent-pane-thread-store-data'
import type { AgentPaneThread } from './activity-thread-types'

export type AgentPaneThreadSnapshot = {
  storeData: AllAgentPaneThreadsStoreData
  allThreads: AgentPaneThread[]
}

type ProjectionStore = {
  getState: () => AppState
  subscribe: (listener: () => void) => () => void
}

type Inputs = {
  storeData: AllAgentPaneThreadsStoreData
  chatNames: StructuredChatTabNames
  agentStatusEpoch: number
}

type EventBuild = ReturnType<typeof buildActivityEvents>

const EMPTY_THREADS: AgentPaneThread[] = []

// Every input but the status map is per-pane context (the worktree resolver reads store fields, not its
// own identity); when all keep identity, only journaled panes rebuild.
function samePaneInputs(previous: Inputs, next: Inputs): boolean {
  if (previous.chatNames !== next.chatNames) {
    return false
  }
  const a: Record<string, unknown> = previous.storeData
  const b: Record<string, unknown> = next.storeData
  for (const key of Object.keys(b)) {
    if (key !== 'agentStatusByPaneKey' && a[key] !== b[key]) {
      return false
    }
  }
  return true
}

function hasLiveActivity(storeData: AllAgentPaneThreadsStoreData, now: number): boolean {
  if (Object.keys(storeData.migrationUnsupportedByPtyId).length > 0) {
    return true
  }
  for (const entry of storeData.agentStatusByPaneKey.values()) {
    if (freshActivityLiveAgentState(entry, now)) {
      return true
    }
  }
  return false
}

/** One per window: the Activity events and threads every surface reads, rebuilt only for changed panes. */
export function createAgentPaneThreadProjection(store: ProjectionStore) {
  // Value: whether that subscriber needs every thread (false: live badge rows only).
  const listeners = new Map<() => void, boolean>()
  let tabProjection: ActivityTabProjectionCache = { raw: null, projected: null }
  let eventCache = createActivityEventBuildCache()
  let threadCache = createAgentPaneThreadReuseCache()
  let badgeThreadCache = createAgentPaneThreadReuseCache()
  let inputs: Inputs | null = null
  let built: { inputs: Inputs; events: EventBuild } | null = null
  let statusCursor: { projection: object; cursor: number } | null = null
  let full: { events: EventBuild; snapshot: AgentPaneThreadSnapshot } | null = null
  let badge: { inputs: Inputs; snapshot: AgentPaneThreadSnapshot } | null = null
  let notifyQueued = false
  let release: (() => void) | null = null

  // Chat names are read only when the naming observer reports them; store writes reuse the last names.
  function readInputs(chatNames = inputs?.chatNames ?? getStructuredChatTabNames()): Inputs {
    const state = store.getState()
    const storeData = selectAllAgentPaneThreadStoreData(state, tabProjection)
    const next = {
      storeData: inputs && shallow(inputs.storeData, storeData) ? inputs.storeData : storeData,
      chatNames,
      agentStatusEpoch: state.agentStatusEpoch
    }
    return inputs &&
      next.storeData === inputs.storeData &&
      next.chatNames === inputs.chatNames &&
      next.agentStatusEpoch === inputs.agentStatusEpoch
      ? inputs
      : next
  }

  function sourceChanged(next: Inputs): void {
    if (next === inputs) {
      return
    }
    inputs = next
    // Why microtask: one rebuild serves every write of a status burst, still before the next frame.
    if (notifyQueued) {
      return
    }
    notifyQueued = true
    queueMicrotask(() => {
      notifyQueued = false
      for (const listener of Array.from(listeners.keys())) {
        if (listeners.has(listener)) {
          listener()
        }
      }
    })
  }

  function currentInputs(): Inputs {
    // Unsubscribed reads (first render) cannot rely on change tracking.
    if (!release || !inputs) {
      inputs = readInputs(getStructuredChatTabNames())
    }
    return inputs
  }

  function events(current: Inputs): EventBuild {
    if (built?.inputs === current) {
      return built.events
    }
    const { storeData, chatNames } = current
    const projection = storeData.agentStatusByPaneKey.projection
    const previous = built
    const previousCursor = statusCursor
    const cursor = projection.changeCursor()
    const changedPaneKeys =
      previous &&
      previousCursor?.projection === projection &&
      samePaneInputs(previous.inputs, current)
        ? (projection.changesSince(previousCursor.cursor) ?? undefined)
        : undefined
    const next = buildActivityEvents(
      {
        chatNames,
        agentStatusByPaneKey: storeData.agentStatusByPaneKey,
        runtimeAgentOrchestrationByPaneKey: storeData.runtimeAgentOrchestrationByPaneKey,
        migrationUnsupportedByPtyId: storeData.migrationUnsupportedByPtyId,
        tabsByWorktree: storeData.tabsByWorktree,
        ptyIdsByTabId: storeData.ptyIdsByTabId,
        unifiedTabsByWorktree: storeData.activityTabs,
        worktreeMap: storeData.worktreeMap,
        repoMap: storeData.repoMap,
        repos: storeData.repos,
        resolveWorktree: storeData.getKnownWorktreeById,
        acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
        activityClearedAtByPaneKey: storeData.activityClearedAtByPaneKey,
        now: Date.now(),
        changedPaneKeys
      },
      eventCache
    )
    built = { inputs: current, events: next }
    statusCursor = { projection, cursor }
    return next
  }

  function readFull(current: Inputs): AgentPaneThreadSnapshot {
    const build = events(current)
    let cached = full
    if (cached?.events !== build) {
      const allThreads = buildAgentPaneThreads(
        {
          events: build.events,
          liveAgentByPaneKey: build.liveAgentByPaneKey,
          paneEntryByPaneKey: build.paneEntryByPaneKey,
          generatedTitlesEnabled: current.storeData.generatedTitlesEnabled
        },
        threadCache
      )
      cached = { events: build, snapshot: { storeData: current.storeData, allThreads } }
      full = cached
    }
    return cached.snapshot
  }

  function readBadge(current: Inputs): AgentPaneThreadSnapshot {
    if (badge?.inputs === current) {
      return badge.snapshot
    }
    let allThreads = EMPTY_THREADS
    if (hasLiveActivity(current.storeData, Date.now())) {
      const build = events(current)
      allThreads = buildAgentPaneThreads(
        {
          events: build.events.filter((event) => build.liveAgentByPaneKey[event.entry.paneKey]),
          liveAgentByPaneKey: build.liveAgentByPaneKey,
          paneEntryByPaneKey: build.paneEntryByPaneKey,
          generatedTitlesEnabled: current.storeData.generatedTitlesEnabled
        },
        badgeThreadCache
      )
    } else if (!Array.from(listeners.values()).some(Boolean)) {
      // Idle badges keep no per-pane builds alive unless a full reader shares them.
      dropBuilds()
    }
    badge = { inputs: current, snapshot: { storeData: current.storeData, allThreads } }
    return badge.snapshot
  }

  function dropBuilds(): void {
    eventCache = createActivityEventBuildCache()
    threadCache = createAgentPaneThreadReuseCache()
    badgeThreadCache = createAgentPaneThreadReuseCache()
    built = null
    full = null
    statusCursor = null
  }

  function read(needsAllThreads: boolean): AgentPaneThreadSnapshot {
    const current = currentInputs()
    return needsAllThreads ? readFull(current) : readBadge(current)
  }

  function subscribe(listener: () => void, needsAllThreads: boolean): () => void {
    if (!release) {
      inputs = readInputs(getStructuredChatTabNames())
      const stopStore = store.subscribe(() => sourceChanged(readInputs()))
      const stopNames = subscribeStructuredChatTabNames(() =>
        sourceChanged(readInputs(getStructuredChatTabNames()))
      )
      release = () => {
        stopStore()
        stopNames()
      }
    }
    const registered = () => listener()
    listeners.set(registered, needsAllThreads)
    return () => {
      listeners.delete(registered)
      if (needsAllThreads && !Array.from(listeners.values()).some(Boolean)) {
        // Badge readers never read the full snapshot; let it go with its last reader.
        full = null
        threadCache = createAgentPaneThreadReuseCache()
      }
      if (listeners.size === 0 && release) {
        release()
        release = null
        // Nothing observes removals now, so keep nothing per pane.
        dropBuilds()
        tabProjection = { raw: null, projected: null }
        inputs = null
        badge = null
      }
    }
  }

  return { read, subscribe }
}

const agentPaneThreadProjection = createAgentPaneThreadProjection(useAppStore)

/** Every Activity thread before any view filter, shared by every surface in this window. */
export function useAgentPaneThreadSnapshot(needsAllThreads: boolean): AgentPaneThreadSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => agentPaneThreadProjection.subscribe(listener, needsAllThreads),
    [needsAllThreads]
  )
  const read = useCallback(() => agentPaneThreadProjection.read(needsAllThreads), [needsAllThreads])
  return useSyncExternalStore(subscribe, read, read)
}
