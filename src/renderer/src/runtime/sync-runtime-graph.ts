import type { AppState } from '@/store/types'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'
import {
  syncRuntimeGraph,
  setTrailingGraphSyncScheduler
} from './sync-runtime-graph/graph-publication'
import {
  findRegisteredTerminalTab,
  graphState,
  registeredTerminalTabKey,
  RUNTIME_GRAPH_SYNC_COALESCE_MS
} from './sync-runtime-graph/graph-state'
import {
  AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS,
  buildRuntimeMobileAgentStatusProjectionForTests,
  resetRuntimeMobileAgentStatusProjectionCacheForTests
} from './sync-runtime-graph/agent-status-projection'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph/sync-key'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { resetRuntimeMobileSyncProjectionCachesForTests } from './sync-runtime-graph/sync-projections'
import type { RegisteredTerminalTab } from './sync-runtime-graph/types'

export type { RegisteredTerminalTab, RuntimeMobileSessionSyncKey } from './sync-runtime-graph/types'
export {
  AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS,
  buildRuntimeMobileAgentStatusProjectionForTests,
  resetRuntimeMobileAgentStatusProjectionCacheForTests,
  resetRuntimeMobileSyncProjectionCachesForTests,
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual,
  buildMobileSessionTabSnapshots
}

export function setRuntimeGraphStoreStateGetter(getter: (() => AppState) | null): void {
  graphState.getStoreState = getter
}

/** True while the target TerminalPane is mounted (lifecycle effect ran). */
export function hasRegisteredRuntimeTerminalTab(tabId: string, worktreeId?: string): boolean {
  return findRegisteredTerminalTab(tabId, worktreeId) !== null
}

export function registerRuntimeTerminalTab(tab: RegisteredTerminalTab): () => void {
  const key = registeredTerminalTabKey(tab.worktreeId, tab.tabId)
  graphState.registeredTabs.set(key, tab)
  graphState.tabRegisteredAt.set(key, Date.now())
  scheduleRuntimeGraphSync()
  return () => {
    // React can mount a replacement before the old effect cleans up.
    if (graphState.registeredTabs.get(key) !== tab) {
      return
    }
    graphState.registeredTabs.delete(key)
    graphState.tabRegisteredAt.delete(key)
    scheduleRuntimeGraphSync()
  }
}

export function focusRuntimeTerminalSurface(
  tabId: string,
  leafId?: string | null,
  worktreeId?: string
): boolean {
  const registered = findRegisteredTerminalTab(tabId, worktreeId)?.tab
  const manager = registered?.getManager()
  if (!manager) {
    return false
  }
  if (!leafId) {
    manager.getActivePane()?.terminal.focus()
    return true
  }
  const resolution = resolveLeafIdForManager(tabId, leafId, manager)
  if (resolution.status !== 'resolved') {
    return false
  }
  manager.setActivePane(resolution.numericPaneId, { focus: true })
  scheduleRuntimeGraphSync()
  return true
}

export function setRuntimeGraphSyncEnabled(enabled: boolean): void {
  graphState.syncEnabled = enabled
  if (!enabled) {
    graphState.syncPendingAfterFlight = false
    clearScheduledRuntimeGraphSync()
    return
  }
  scheduleRuntimeGraphSync()
}

function clearScheduledRuntimeGraphSync(): void {
  if (graphState.syncTimer !== null) {
    clearTimeout(graphState.syncTimer)
    graphState.syncTimer = null
  }
  graphState.syncScheduled = false
}

export function scheduleRuntimeGraphSync(): void {
  if (!graphState.syncEnabled || graphState.syncScheduled) {
    return
  }
  if (graphState.syncInFlight) {
    graphState.syncPendingAfterFlight = true
    return
  }
  graphState.syncScheduled = true
  // Collapse separate title/status tasks into one frame-sized graph publication.
  graphState.syncTimer = setTimeout(() => {
    graphState.syncTimer = null
    graphState.syncScheduled = false
    void runRuntimeGraphSync()
  }, RUNTIME_GRAPH_SYNC_COALESCE_MS)
}

async function runRuntimeGraphSync(): Promise<void> {
  if (graphState.syncInFlight) {
    graphState.syncPendingAfterFlight = true
    return
  }
  graphState.syncInFlight = true
  try {
    await syncRuntimeGraph()
  } finally {
    graphState.syncInFlight = false
    if (graphState.syncPendingAfterFlight) {
      graphState.syncPendingAfterFlight = false
      scheduleRuntimeGraphSync()
    }
  }
}

setTrailingGraphSyncScheduler(scheduleRuntimeGraphSync)
