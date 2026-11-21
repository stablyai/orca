import type { ActivityThreadMode } from './activity-thread-projection'
import type { AgentPaneThreadReuseCache } from './activity-thread-builder'
import type { AgentPaneThread } from './activity-thread-types'

/** Panes whose thread changed since the listener's last call; null means re-read every pane. */
export type ActivityThreadChangeListener = (paneKeys: ReadonlySet<string> | null) => void

type ThreadsByPaneKey = ReadonlyMap<string, { thread: AgentPaneThread }>

const threadsByPaneKey: Record<ActivityThreadMode, ThreadsByPaneKey> = {
  all: new Map(),
  live: new Map()
}
const changeListeners: Record<ActivityThreadMode, Set<ActivityThreadChangeListener>> = {
  all: new Set(),
  live: new Set()
}

/** A build's changes, or null when the projection was dropped; a first build resyncs, as it cannot name the panes it dropped. */
export function publishActivityThreadChanges(
  mode: ActivityThreadMode,
  build: AgentPaneThreadReuseCache | null,
  firstBuild = false
): void {
  threadsByPaneKey[mode] = build?.previousByPaneKey ?? new Map()
  const paneKeys = build && !firstBuild ? build.changedPaneKeys : null
  if (build) {
    // Tracking costs each build a pass, so only builds with a reader pay; a later reader resyncs.
    build.trackChanges = changeListeners[mode].size > 0
  }
  if (paneKeys === null || paneKeys.size > 0) {
    for (const listener of changeListeners[mode]) {
      listener(paneKeys)
    }
  }
}

/** Observe which panes' threads each build changes; readers must also subscribe to keep the build alive. */
export function subscribeActivityThreadChanges(
  mode: ActivityThreadMode,
  listener: ActivityThreadChangeListener
): () => void {
  changeListeners[mode].add(listener)
  return () => changeListeners[mode].delete(listener)
}

/** One pane's thread from the last `mode` build, without scanning the list. */
export function readActivityThread(
  mode: ActivityThreadMode,
  paneKey: string
): AgentPaneThread | undefined {
  return threadsByPaneKey[mode].get(paneKey)?.thread
}
