import type { AppState } from '@/store/types'
import {
  syncRuntimeGraph,
  setTrailingGraphSyncScheduler
} from './sync-runtime-graph/graph-publication'
import { graphState, RUNTIME_GRAPH_SYNC_COALESCE_MS } from './sync-runtime-graph/graph-state'
import { subscribeMountedTerminalTabChanges } from './mounted-terminal-tab-registry'
import { measureTerminalGroupGridSizes } from './sync-runtime-graph/terminal-group-grid-sizes'
export function setRuntimeGraphStoreStateGetter(getter: (() => AppState) | null): void {
  graphState.getStoreState = getter
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

/** Republishes the graph only when the grid a new tab would get in some group changed. */
export function scheduleRuntimeGraphSyncIfGroupGridSizesChanged(): void {
  const state = graphState.getStoreState?.()
  if (!state) {
    return
  }
  const sizes = measureTerminalGroupGridSizes(state.settings?.terminalFontSize ?? 14)
  if (JSON.stringify(sizes ?? null) !== graphState.publishedTerminalGroupGridSizesKey) {
    scheduleRuntimeGraphSync()
  }
}

/** A tab group body resized (window, divider, sidebar): its group's grid may have changed. */
export function observeTabGroupBodyGridSize(body: HTMLElement): () => void {
  const observer = new ResizeObserver(scheduleRuntimeGraphSyncIfGroupGridSizesChanged)
  observer.observe(body)
  return () => observer.disconnect()
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
subscribeMountedTerminalTabChanges(scheduleRuntimeGraphSync)
