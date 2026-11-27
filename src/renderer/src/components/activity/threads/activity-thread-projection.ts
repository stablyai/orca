import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { subscribeTranslationResourceVersion } from '@/i18n/translation-resource-version'
import {
  getStructuredChatTabNames,
  subscribeStructuredChatTabNames
} from '@/runtime/native-chat/naming/structured-chat-name-observation'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { buildActivityEvents } from '../events/activity-event-builder'
import { hasFreshActivityLiveAgent } from '../events/activity-event-state'
import {
  createActivityEventBuildCache,
  resetActivityEventBuildCache
} from '../events/activity-event-build-cache'
import { standaloneActivityWorktreeScope } from '../events/activity-standalone-worktree'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'
import type { AgentPaneThread } from './activity-thread-types'
import { publishActivityThreadChanges } from './activity-thread-change-feed'
import {
  releaseActivityTabProjection,
  selectAllAgentPaneThreadStoreData,
  type AllAgentPaneThreadsStoreData
} from './use-agent-pane-thread-store-data'

/** `live` keeps only panes with a live turn (the sidebar badge); `all` is every thread. */
export type ActivityThreadMode = 'all' | 'live'

export type ActivityThreadSnapshot = {
  storeData: AllAgentPaneThreadsStoreData
  allThreads: AgentPaneThread[]
}

/** What a build reads; its identity changes only when one of these does, so React compares it cheaply. */
export type ActivityThreadInputs = {
  storeData: AllAgentPaneThreadsStoreData
  /** Freshness expiry changes output without a store write. */
  agentStatusEpoch: number
  chatNames: StructuredChatTabNames
  /** Standalone owner names are translated. */
  scope: string
}

type ActivityEventsBuild = ReturnType<typeof buildActivityEvents>

type ThreadProjection = {
  cache: ReturnType<typeof createAgentPaneThreadReuseCache>
  build: ActivityEventsBuild | null
  generatedTitlesEnabled: boolean
  threads: AgentPaneThread[]
}

const MODES: readonly ActivityThreadMode[] = ['all', 'live']
const NO_THREADS: AgentPaneThread[] = []
const UNSUBSCRIBED_RELEASE_MS = 1000

function createThreadProjection(): ThreadProjection {
  return {
    cache: createAgentPaneThreadReuseCache(),
    build: null,
    generatedTitlesEnabled: false,
    threads: NO_THREADS
  }
}

// One owner per window: Activity, the sidebar and the phone publisher read the same build.
const listeners: Record<ActivityThreadMode, Set<() => void>> = { all: new Set(), live: new Set() }
const threadProjections: Record<ActivityThreadMode, ThreadProjection> = {
  all: createThreadProjection(),
  live: createThreadProjection()
}
const snapshots: Record<
  ActivityThreadMode,
  { inputs: ActivityThreadInputs; snapshot: ActivityThreadSnapshot } | null
> = { all: null, live: null }
const eventBuildCache = createActivityEventBuildCache()
let eventsProjection: { inputs: ActivityThreadInputs; build: ActivityEventsBuild } | null = null
let currentInputs: ActivityThreadInputs | null = null
// Kept apart from the inputs so a cached build never holds the whole store (drafts, buffers) alive.
let currentState: AppState | null = null
let currentNames: StructuredChatTabNames | null = null
let currentScope: string | null = null
let chatNames: StructuredChatTabNames | null = null
let detach: (() => void) | null = null
const releaseTimers: Record<ActivityThreadMode, ReturnType<typeof setTimeout> | null> = {
  all: null,
  live: null
}

function listenerCount(): number {
  return listeners.all.size + listeners.live.size
}

function notify(): void {
  for (const mode of MODES) {
    for (const listener of listeners[mode]) {
      listener()
    }
  }
}

function releaseEventsProjection(): void {
  eventsProjection = null
  resetActivityEventBuildCache(eventBuildCache)
}

function releaseAll(): void {
  releaseEventsProjection()
  releaseActivityTabProjection()
  for (const mode of MODES) {
    threadProjections[mode] = createThreadProjection()
    snapshots[mode] = null
    publishActivityThreadChanges(mode, null)
  }
  currentInputs = null
  currentState = null
  currentNames = null
  currentScope = null
  chatNames = null
}

function attach(): () => void {
  chatNames = getStructuredChatTabNames()
  const stops = [
    useAppStore.subscribe(notify),
    subscribeStructuredChatTabNames(() => {
      chatNames = getStructuredChatTabNames()
      notify()
    }),
    subscribeTranslationResourceVersion(notify)
  ]
  return () => stops.forEach((stop) => stop())
}

function releaseMode(mode: ActivityThreadMode): void {
  threadProjections[mode] = createThreadProjection()
  snapshots[mode] = null
  publishActivityThreadChanges(mode, null)
  if (listenerCount() === 0) {
    releaseAll()
    return
  }
  // The shared events build stays only while an observed mode needs it; an idle badge builds nothing.
  if (listeners.all.size === 0 && threadProjections.live.build === null) {
    releaseEventsProjection()
  }
}

/** Each mode lives while observed; a read that never subscribes (an uncommitted render) or a reader switching modes is released after a short grace. */
function scheduleRelease(mode: ActivityThreadMode): void {
  if (releaseTimers[mode] !== null) {
    return
  }
  releaseTimers[mode] = setTimeout(() => {
    releaseTimers[mode] = null
    if (listeners[mode].size === 0) {
      releaseMode(mode)
    }
  }, UNSUBSCRIBED_RELEASE_MS)
}

function cancelRelease(mode: ActivityThreadMode): void {
  const timer = releaseTimers[mode]
  if (timer !== null) {
    clearTimeout(timer)
    releaseTimers[mode] = null
  }
}

/** Current inputs; storeData keeps its identity until a field the projection reads changes. */
function readInputs(): ActivityThreadInputs {
  const state = useAppStore.getState()
  // Subscribed reads use the observed names; a render before the first subscribe reads them directly.
  const names = chatNames ?? getStructuredChatTabNames()
  const scope = standaloneActivityWorktreeScope()
  const previous = currentInputs
  if (previous && currentState === state && currentNames === names && currentScope === scope) {
    return previous
  }
  currentState = state
  currentNames = names
  currentScope = scope
  const selected = selectAllAgentPaneThreadStoreData(state)
  const next: ActivityThreadInputs = {
    storeData: previous && shallow(previous.storeData, selected) ? previous.storeData : selected,
    agentStatusEpoch: state.agentStatusEpoch,
    chatNames: names,
    scope
  }
  currentInputs = previous && sameBuildInputs(previous, next) ? previous : next
  return currentInputs
}

function sameBuildInputs(a: ActivityThreadInputs, b: ActivityThreadInputs): boolean {
  return (
    a.storeData === b.storeData &&
    a.agentStatusEpoch === b.agentStatusEpoch &&
    a.chatNames === b.chatNames &&
    a.scope === b.scope
  )
}

function projectActivityEvents(inputs: ActivityThreadInputs): ActivityEventsBuild {
  if (eventsProjection && sameBuildInputs(eventsProjection.inputs, inputs)) {
    return eventsProjection.build
  }
  const { storeData } = inputs
  const unifiedTabsByWorktree = storeData.activityTabs
  // Global history caps affect live-thread unread and search state.
  const build = buildActivityEvents(
    {
      chatNames: inputs.chatNames,
      agentStatusByPaneKey: storeData.agentStatusByPaneKey,
      runtimeAgentOrchestrationByPaneKey: storeData.runtimeAgentOrchestrationByPaneKey,
      migrationUnsupportedByPtyId: storeData.migrationUnsupportedByPtyId,
      tabsByWorktree: storeData.tabsByWorktree,
      ptyIdsByTabId: storeData.ptyIdsByTabId,
      unifiedTabsByWorktree,
      structuredTabs: storeData.structuredTabs,
      worktreeMap: storeData.worktreeMap,
      repoMap: storeData.repoMap,
      repos: storeData.repos,
      resolveWorktree: storeData.getKnownWorktreeById,
      resolveWorktreeInputs: [
        selectWorktreesByRepo(storeData),
        selectFolderWorkspaces(storeData),
        storeData.projectGroups,
        storeData.repos,
        selectDetectedWorktreesByRepo(storeData),
        storeData.floatingWorkspacePath
      ],
      acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
      activityClearedAtByPaneKey: storeData.activityClearedAtByPaneKey,
      // Read at build time; agentStatusEpoch in the inputs rebuilds when a freshness boundary passes.
      now: Date.now()
    },
    eventBuildCache
  )
  eventsProjection = { inputs, build }
  return build
}

function projectThreads(inputs: ActivityThreadInputs, mode: ActivityThreadMode): AgentPaneThread[] {
  if (
    mode === 'live' &&
    !hasFreshActivityLiveAgent(
      inputs.storeData.agentStatusByPaneKey,
      inputs.storeData.migrationUnsupportedByPtyId
    )
  ) {
    if (threadProjections.live.build !== null) {
      threadProjections.live = createThreadProjection()
      publishActivityThreadChanges('live', null)
    }
    // An empty badge alone keeps nothing; with a full reader mounted the shared build stays warm.
    if (listeners.all.size === 0) {
      releaseEventsProjection()
    }
    return NO_THREADS
  }
  const build = projectActivityEvents(inputs)
  const projection = threadProjections[mode]
  const { generatedTitlesEnabled } = inputs.storeData
  if (projection.build === build && projection.generatedTitlesEnabled === generatedTitlesEnabled) {
    return projection.threads
  }
  const fresh = projection.build === null
  projection.threads = buildAgentPaneThreads(
    {
      events:
        mode === 'live'
          ? build.events.filter((event) => build.liveAgentByPaneKey[event.entry.paneKey])
          : build.events,
      liveAgentByPaneKey: build.liveAgentByPaneKey,
      paneEntryByPaneKey: build.paneEntryByPaneKey,
      generatedTitlesEnabled
    },
    projection.cache
  )
  projection.build = build
  projection.generatedTitlesEnabled = generatedTitlesEnabled
  publishActivityThreadChanges(mode, projection.cache, fresh)
  return projection.threads
}

/** useSyncExternalStore's snapshot: only selects inputs, so a burst of store writes in one task costs
 *  no builds; the build runs once when a reader renders. */
export function getActivityThreadInputs(mode: ActivityThreadMode): ActivityThreadInputs {
  const inputs = readInputs()
  if (listeners[mode].size === 0) {
    scheduleRelease(mode)
  }
  return inputs
}

/** The window's Activity threads for `mode` from `inputs`; built once per input set and shared. */
export function readActivityThreadSnapshot(
  mode: ActivityThreadMode,
  inputs: ActivityThreadInputs
): ActivityThreadSnapshot {
  let current = snapshots[mode]
  if (!current || !sameBuildInputs(current.inputs, inputs)) {
    const allThreads = projectThreads(inputs, mode)
    const snapshot =
      current?.snapshot.storeData === inputs.storeData && current.snapshot.allThreads === allThreads
        ? current.snapshot
        : { storeData: inputs.storeData, allThreads }
    current = { inputs, snapshot }
    snapshots[mode] = current
  }
  return current.snapshot
}

/** Observe the projection; the first reader attaches it, and caches go shortly after the last one leaves. */
export function subscribeActivityThreads(
  mode: ActivityThreadMode,
  listener: () => void
): () => void {
  cancelRelease(mode)
  listeners[mode].add(listener)
  detach ??= attach()
  return () => {
    listeners[mode].delete(listener)
    if (listenerCount() === 0) {
      detach?.()
      detach = null
      chatNames = null
    }
    if (listeners[mode].size === 0) {
      // The grace keeps the shared events build warm while the sidebar switches between list and badge.
      scheduleRelease(mode)
    }
  }
}
