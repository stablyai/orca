import { shallow } from 'zustand/shallow'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import { buildActivityEvents } from './activity-event-builder'
import { freshActivityLiveAgentState } from './activity-event-state'
import {
  createActivityEventBuildCache,
  resetActivityEventBuildCache
} from './activity-event-build-cache'
import { standaloneActivityWorktreeScope } from './activity-standalone-worktree'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'
import type { AgentPaneThread } from './activity-thread-types'
import {
  releaseActivityTabProjection,
  type AllAgentPaneThreadsStoreData
} from './use-agent-pane-thread-store-data'

export type ActivityProjectionInputs = {
  storeData: AllAgentPaneThreadsStoreData
  /** Freshness expiry changes output without a store write. */
  agentStatusEpoch: number
  chatNames: StructuredChatTabNames
}

type ActivityEventsBuild = ReturnType<typeof buildActivityEvents>

type ThreadProjection = {
  cache: ReturnType<typeof createAgentPaneThreadReuseCache>
  build: ActivityEventsBuild | null
  generatedTitlesEnabled: boolean
  threads: AgentPaneThread[]
}

type ProjectionMode = 'all' | 'live'

function createThreadProjection(): ThreadProjection {
  return {
    cache: createAgentPaneThreadReuseCache(),
    build: null,
    generatedTitlesEnabled: false,
    threads: []
  }
}

// One producer per window: Activity, the sidebar and the phone publisher read the same build.
const eventBuildCache = createActivityEventBuildCache()
let eventsProjection: {
  inputs: ActivityProjectionInputs
  scope: string
  build: ActivityEventsBuild
} | null = null
const NO_THREADS: AgentPaneThread[] = []
const threadProjections: Record<ProjectionMode, ThreadProjection> = {
  all: createThreadProjection(),
  live: createThreadProjection()
}
let mountedReaders = 0
const mountedReadersByMode: Record<ProjectionMode, number> = { all: 0, live: 0 }

function releaseEventsProjection(): void {
  eventsProjection = null
  resetActivityEventBuildCache(eventBuildCache)
}

/** Count a mounted reader; the last one out drops everything so retired workspaces are not retained. */
export function retainActivityThreadProjection(): () => void {
  mountedReaders += 1
  return () => {
    mountedReaders -= 1
    if (mountedReaders === 0) {
      releaseEventsProjection()
      releaseActivityTabProjection()
      threadProjections.all = createThreadProjection()
      threadProjections.live = createThreadProjection()
    }
  }
}

/** Count a reader of one mode; switching modes keeps the shared events build warm. */
export function retainActivityThreadMode(mode: ProjectionMode): () => void {
  mountedReadersByMode[mode] += 1
  return () => {
    mountedReadersByMode[mode] -= 1
    if (mountedReadersByMode[mode] === 0) {
      threadProjections[mode] = createThreadProjection()
    }
  }
}

function sameInputs(a: ActivityProjectionInputs, b: ActivityProjectionInputs): boolean {
  return (
    a.agentStatusEpoch === b.agentStatusEpoch &&
    a.chatNames === b.chatNames &&
    shallow(a.storeData, b.storeData)
  )
}

function projectActivityEvents(inputs: ActivityProjectionInputs): ActivityEventsBuild {
  const scope = standaloneActivityWorktreeScope()
  if (
    eventsProjection &&
    eventsProjection.scope === scope &&
    sameInputs(eventsProjection.inputs, inputs)
  ) {
    return eventsProjection.build
  }
  const { storeData, chatNames } = inputs
  // Global history caps affect live-thread unread and search state.
  const build = buildActivityEvents(
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
  eventsProjection = { inputs, scope, build }
  return build
}

function hasLiveActivity({ storeData }: ActivityProjectionInputs): boolean {
  const now = Date.now()
  return (
    Object.keys(storeData.migrationUnsupportedByPtyId).length > 0 ||
    Array.from(storeData.agentStatusByPaneKey.values()).some((entry) =>
      freshActivityLiveAgentState(entry, now)
    )
  )
}

/** Every Activity thread before view filters; `live` keeps only panes with a live turn. */
export function projectAgentPaneThreads(
  inputs: ActivityProjectionInputs,
  mode: 'all' | 'live'
): AgentPaneThread[] {
  if (mode === 'live' && !hasLiveActivity(inputs)) {
    threadProjections.live = createThreadProjection()
    // An empty badge alone keeps nothing; with a full reader mounted the shared build stays warm.
    if (mountedReadersByMode.all === 0) {
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
  return projection.threads
}
