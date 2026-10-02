import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { syncAgentHookCompletionNotificationsForStoreUpdate } from '../agent-hook-completion-notifications'
import { registerAgentStatusListeners } from './agent-status-listeners'
import { useAppStore } from '../../store'
import {
  createAgentStatusPaneRoutingIndex,
  resolvePaneKeyFromRoutingIndex
} from './agent-status-pane-routing-index'
import { createAgentStatusEventApplicator } from './agent-status-event-applicator'
import type {
  AgentStatusApplyResult,
  AgentStatusBatchContext,
  AgentStatusBatchEvent,
  PendingAgentStatusEvent
} from './agent-status-bridge-types'
import { shouldRetryPendingAgentStatusesAfterStoreUpdate } from './agent-status-pending-retry-gate'
import {
  armAgentStatusStartupSnapshot,
  holdAgentStatusStartupSnapshotForReplay,
  releaseAgentStatusStartupSnapshotReplayHold,
  resetAgentStatusStartupSnapshotGate,
  settleAgentStatusStartupSnapshot
} from './agent-status-startup-snapshot-gate'

const PENDING_AGENT_STATUS_RETRY_MS = 100
const PENDING_AGENT_STATUS_TTL_MS = 15_000
const MAX_PENDING_AGENT_STATUS_EVENTS = 100
const LIVE_AGENT_STATUS_BURST_WINDOW_MS = 33

export type AgentStatusIpcBridge = {
  disposeAsyncState: () => void
  unsubscribeStore: () => void
}

export function registerAgentStatusIpcBridge(unsubs: (() => void)[]): AgentStatusIpcBridge {
  const pendingAgentStatusEvents: PendingAgentStatusEvent[] = []
  const transientClearWatermarkByConnectionId = new Map<string, number>()
  let disposed = false
  let pendingAgentStatusRetryTimer: ReturnType<typeof setTimeout> | null = null
  let isFlushingAgentStatuses = false
  const liveAgentStatusBurstQueue: AgentStatusIpcPayload[] = []
  let liveAgentStatusBurstTimer: ReturnType<typeof setTimeout> | null = null
  let lastLiveAgentStatusApplyAt = 0
  function schedulePendingAgentStatusFlush(): void {
    if (pendingAgentStatusRetryTimer !== null || pendingAgentStatusEvents.length === 0) {
      return
    }
    pendingAgentStatusRetryTimer = globalThis.setTimeout(() => {
      pendingAgentStatusRetryTimer = null
      flushPendingAgentStatuses()
    }, PENDING_AGENT_STATUS_RETRY_MS)
  }

  function enqueuePendingAgentStatus(
    data: AgentStatusIpcPayload,
    options?: { replay?: boolean }
  ): void {
    pendingAgentStatusEvents.push({
      data,
      firstSeenAt: Date.now(),
      replay: options?.replay === true
    })
    while (pendingAgentStatusEvents.length > MAX_PENDING_AGENT_STATUS_EVENTS) {
      pendingAgentStatusEvents.shift()
    }
    schedulePendingAgentStatusFlush()
  }

  function flushPendingAgentStatuses(): void {
    // Why: guard re-entrancy — a subscriber firing mid-loop must not reprocess queued events the outer flush already owns.
    if (isFlushingAgentStatuses) {
      return
    }
    if (pendingAgentStatusEvents.length === 0) {
      // A clear can empty the queue without entering the flush loop below.
      releaseAgentStatusStartupSnapshotReplayHold(false, pendingAgentStatusEvents)
      return
    }
    isFlushingAgentStatuses = true
    try {
      const now = Date.now()
      const candidates = pendingAgentStatusEvents
        .splice(0)
        .filter((event) => now - event.firstSeenAt <= PENDING_AGENT_STATUS_TTL_MS)
      let results: AgentStatusApplyResult[]
      try {
        results = applyAgentStatusBatch(
          candidates.map((event) => ({ data: event.data, replay: event.replay, retry: true }))
        )
      } catch (err) {
        // Why: the queue was already spliced, so a throwing fold would drop the whole
        // burst and strand every pane in it. Requeue ahead of newer arrivals and retry.
        pendingAgentStatusEvents.unshift(...candidates)
        throw err
      }
      for (let index = 0; index < candidates.length; index += 1) {
        if (results[index] === 'pending') {
          pendingAgentStatusEvents.push(candidates[index])
        }
      }
      if (pendingAgentStatusEvents.length === 0 && pendingAgentStatusRetryTimer !== null) {
        globalThis.clearTimeout(pendingAgentStatusRetryTimer)
        pendingAgentStatusRetryTimer = null
      }
      releaseAgentStatusStartupSnapshotReplayHold(
        pendingAgentStatusEvents.some((event) => event.replay),
        pendingAgentStatusEvents
      )
    } finally {
      isFlushingAgentStatuses = false
      schedulePendingAgentStatusFlush()
    }
  }

  const applyAgentStatus = createAgentStatusEventApplicator({
    pendingAgentStatusEvents,
    transientClearWatermarkByConnectionId,
    enqueuePendingAgentStatus
  })
  let snapshotRequestedForReadyWindow = false
  let snapshotRequestId = 0
  const requestAgentStatusSnapshotIfReady = (): void => {
    const store = useAppStore.getState()
    if (!store.workspaceSessionReady) {
      if (snapshotRequestedForReadyWindow) {
        resetAgentStatusStartupSnapshotGate()
      }
      snapshotRequestedForReadyWindow = false
      return
    }
    if (snapshotRequestedForReadyWindow) {
      return
    }
    const getSnapshot = window.api.agentStatus.getSnapshot
    if (typeof getSnapshot !== 'function') {
      return
    }
    snapshotRequestedForReadyWindow = true
    const requestId = ++snapshotRequestId
    // Why: the first restored pane connects in this same turn. Arm before the IPC round-trip so
    // that pane can wait until this snapshot is applied (#24291).
    const snapshotEpoch = armAgentStatusStartupSnapshot()
    void Promise.resolve()
      .then(() => getSnapshot())
      .then((entries) => {
        if (disposed || requestId !== snapshotRequestId) {
          return
        }
        const current = useAppStore.getState()
        if (!current.workspaceSessionReady) {
          return
        }
        const results = applyAgentStatusBatch(entries.map((data) => ({ data, replay: true })))
        // Why: an unroutable snapshot entry is replayed later. Hold the reattach gate until then (#24291).
        if (results.some((result) => result === 'pending')) {
          holdAgentStatusStartupSnapshotForReplay(snapshotEpoch, pendingAgentStatusEvents)
        }
        const getMigrationUnsupportedSnapshot =
          window.api.agentStatus.getMigrationUnsupportedSnapshot
        if (typeof getMigrationUnsupportedSnapshot !== 'function') {
          return
        }
        void getMigrationUnsupportedSnapshot().then((unsupportedEntries) => {
          if (disposed || requestId !== snapshotRequestId) {
            return
          }
          const unsupportedStore = useAppStore.getState()
          if (!unsupportedStore.workspaceSessionReady) {
            return
          }
          const unsupportedRoutingIndex = createAgentStatusPaneRoutingIndex(unsupportedStore)
          for (const entry of unsupportedEntries) {
            if (
              entry.paneKey &&
              resolvePaneKeyFromRoutingIndex(unsupportedRoutingIndex, entry.paneKey).exists
            ) {
              unsupportedStore.setMigrationUnsupportedPty(entry)
            }
          }
        })
      })
      .catch((err) => {
        // Why: stay latched on failure; the store subscriber fires on every update, so resetting here would turn a persistent IPC failure into a retry storm (flag clears on workspaceSessionReady toggle).
        console.warn('[agent-status] failed to load startup snapshot:', err)
      })
      .finally(() => {
        const replayStillQueued = pendingAgentStatusEvents.some((event) => event.replay)
        if (
          releaseAgentStatusStartupSnapshotReplayHold(replayStillQueued, pendingAgentStatusEvents)
        ) {
          return
        }
        settleAgentStatusStartupSnapshot(snapshotEpoch)
      })
  }

  function applyAgentStatusBatch(
    events: readonly AgentStatusBatchEvent[]
  ): AgentStatusApplyResult[] {
    if (events.length === 0) {
      return []
    }
    return useAppStore.getState().transactAgentStatuses((transaction) => {
      const batch: AgentStatusBatchContext = {
        transaction,
        routingIndex: createAgentStatusPaneRoutingIndex(transaction.getState()),
        projectedTitlesByTabId: new Map(),
        tabTitlesByTabId: new Map(),
        notificationEffects: []
      }
      const results = events.map(({ data, replay, retry }) =>
        applyAgentStatus(data, { batch, replay, retry })
      )
      if (batch.tabTitlesByTabId.size > 0) {
        transaction.afterCommit(() => {
          useAppStore
            .getState()
            .updateTabTitles(
              [...batch.tabTitlesByTabId].map(([tabId, title]) => ({ tabId, title }))
            )
        })
      }
      for (const effect of batch.notificationEffects) {
        transaction.afterCommit(effect)
      }
      return results
    })
  }

  function applyLiveAgentStatusBatch(batch: readonly AgentStatusIpcPayload[]): boolean {
    return applyAgentStatusBatch(batch.map((data) => ({ data }))).some(
      (result) => result === 'applied'
    )
  }

  function flushLiveAgentStatusBurst(): void {
    liveAgentStatusBurstTimer = null
    lastLiveAgentStatusApplyAt = Date.now()
    // Why: splice before publishing — synchronous Zustand subscribers can enqueue the next burst.
    const batch = liveAgentStatusBurstQueue.splice(0)
    if (!applyLiveAgentStatusBatch(batch)) {
      lastLiveAgentStatusApplyAt = 0
    }
  }

  function drainQueuedLiveAgentStatusesForPane(paneKey: string): void {
    const queuedForPane: AgentStatusIpcPayload[] = []
    const remaining: AgentStatusIpcPayload[] = []
    for (const queued of liveAgentStatusBurstQueue) {
      if (queued.paneKey === paneKey) {
        queuedForPane.push(queued)
      } else {
        remaining.push(queued)
      }
    }
    liveAgentStatusBurstQueue.length = 0
    liveAgentStatusBurstQueue.push(...remaining)
    applyLiveAgentStatusBatch(queuedForPane)
  }

  function enqueueLiveAgentStatus(data: AgentStatusIpcPayload): void {
    const now = Date.now()
    if (
      liveAgentStatusBurstTimer === null &&
      now - lastLiveAgentStatusApplyAt >= LIVE_AGENT_STATUS_BURST_WINDOW_MS
    ) {
      lastLiveAgentStatusApplyAt = now
      // Why: only an applied event commits state and costs a render pass —
      // a dropped/pending leading edge must not make its successor pay
      // burst latency (startup replay and unmounted panes stay immediate).
      if (applyAgentStatus(data) !== 'applied') {
        lastLiveAgentStatusApplyAt = 0
      }
      return
    }
    liveAgentStatusBurstQueue.push(data)
    if (liveAgentStatusBurstTimer === null) {
      liveAgentStatusBurstTimer = globalThis.setTimeout(
        flushLiveAgentStatusBurst,
        LIVE_AGENT_STATUS_BURST_WINDOW_MS
      )
    }
  }

  registerAgentStatusListeners({
    unsubs,
    enqueueLiveAgentStatus,
    drainQueuedLiveAgentStatusesForPane,
    pendingAgentStatusEvents,
    transientClearWatermarkByConnectionId,
    liveAgentStatusBurstQueue
  })

  // Why: main hook server is the durable source of truth; pull the snapshot only after tabs are ready so early startup pushes can be ignored, not buffered.
  requestAgentStatusSnapshotIfReady()
  const unsubscribeAgentStatusStore = useAppStore.subscribe((state, previousState) => {
    requestAgentStatusSnapshotIfReady()
    // Why: the timer covers module-owned rekeys; unrelated store writes cannot change attribution and must not rebuild its routing index.
    if (
      pendingAgentStatusEvents.length > 0 &&
      shouldRetryPendingAgentStatusesAfterStoreUpdate(state, previousState)
    ) {
      flushPendingAgentStatuses()
    }
    syncAgentHookCompletionNotificationsForStoreUpdate(state, previousState)
  })

  return {
    disposeAsyncState: () => {
      disposed = true
      snapshotRequestId += 1
      resetAgentStatusStartupSnapshotGate()
      if (pendingAgentStatusRetryTimer !== null) {
        globalThis.clearTimeout(pendingAgentStatusRetryTimer)
      }
      pendingAgentStatusEvents.length = 0
      if (liveAgentStatusBurstTimer !== null) {
        globalThis.clearTimeout(liveAgentStatusBurstTimer)
        liveAgentStatusBurstTimer = null
      }
      liveAgentStatusBurstQueue.length = 0
    },
    unsubscribeStore: unsubscribeAgentStatusStore
  }
}
