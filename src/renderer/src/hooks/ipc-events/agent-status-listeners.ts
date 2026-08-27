import { CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../shared/agent-status-types'
import {
  resolveLegacyWorkerTerminalRecoveryAction,
  rollbackLegacyWorkerTerminalSurfaceInStore
} from '../legacy-worker-terminal-recovery-event'
import { useAppStore } from '../../store'
import { resolvePaneKey } from './agent-status-routing'
import type { PendingAgentStatusEvent } from './agent-status-bridge-types'

export function registerAgentStatusListeners(args: {
  unsubs: (() => void)[]
  enqueueLiveAgentStatus: (data: AgentStatusIpcPayload) => void
  drainQueuedLiveAgentStatusesForPane: (paneKey: string) => void
  pendingAgentStatusEvents: PendingAgentStatusEvent[]
  transientClearWatermarkByConnectionId: Map<string, number>
  liveAgentStatusBurstQueue: AgentStatusIpcPayload[]
}): void {
  const {
    unsubs,
    enqueueLiveAgentStatus,
    drainQueuedLiveAgentStatusesForPane,
    pendingAgentStatusEvents,
    transientClearWatermarkByConnectionId,
    liveAgentStatusBurstQueue
  } = args
  unsubs.push(
    window.api.agentStatus.onSet((data) => {
      enqueueLiveAgentStatus(data)
    })
  )
  const unsubscribeAgentStatusClear = window.api.agentStatus.onClear?.(
    (data: AgentStatusClearIpcPayload) => {
      if (typeof data !== 'object' || data === null) {
        return
      }
      if ('transient' in data && data.transient === true) {
        if (
          typeof data.connectionId !== 'string' ||
          data.connectionId.length === 0 ||
          !Number.isFinite(data.clearedAt)
        ) {
          return
        }
        const previousWatermark = transientClearWatermarkByConnectionId.get(data.connectionId) ?? -1
        const effectiveWatermark = Math.max(previousWatermark, data.clearedAt)
        transientClearWatermarkByConnectionId.set(data.connectionId, effectiveWatermark)
        for (let index = pendingAgentStatusEvents.length - 1; index >= 0; index -= 1) {
          const pending = pendingAgentStatusEvents[index].data
          if (
            pending.connectionId === data.connectionId &&
            pending.receivedAt <= effectiveWatermark
          ) {
            pendingAgentStatusEvents.splice(index, 1)
          }
        }
        for (let index = liveAgentStatusBurstQueue.length - 1; index >= 0; index -= 1) {
          const queued = liveAgentStatusBurstQueue[index]
          if (
            queued.connectionId === data.connectionId &&
            queued.receivedAt <= effectiveWatermark
          ) {
            liveAgentStatusBurstQueue.splice(index, 1)
          }
        }
        useAppStore.getState().clearTransientAgentStatuses(data.connectionId, effectiveWatermark)
        return
      }
      if (!('paneKey' in data) || typeof data.paneKey !== 'string') {
        return
      }
      // Why: preserve set→clear FIFO so a queued completion still survives pane teardown.
      if (liveAgentStatusBurstQueue.some((queued) => queued.paneKey === data.paneKey)) {
        drainQueuedLiveAgentStatusesForPane(data.paneKey)
      }
      for (let index = pendingAgentStatusEvents.length - 1; index >= 0; index -= 1) {
        if (pendingAgentStatusEvents[index].data.paneKey === data.paneKey) {
          pendingAgentStatusEvents.splice(index, 1)
        }
      }
      const store = useAppStore.getState()
      if (store.agentStatusByPaneKey[data.paneKey]?.state === 'done') {
        return
      }
      store.removeAgentStatus(data.paneKey)
    }
  )
  if (unsubscribeAgentStatusClear) {
    unsubs.push(unsubscribeAgentStatusClear)
  }
  const unsubscribeMigrationUnsupported = window.api.agentStatus.onMigrationUnsupported?.(
    (entry) => {
      const store = useAppStore.getState()
      if (!store.workspaceSessionReady) {
        return
      }
      if (entry.paneKey && resolvePaneKey(store, entry.paneKey).exists) {
        store.setMigrationUnsupportedPty(entry)
      }
    }
  )
  if (unsubscribeMigrationUnsupported) {
    unsubs.push(unsubscribeMigrationUnsupported)
  }
  const unsubscribeMigrationUnsupportedClear = window.api.agentStatus.onMigrationUnsupportedClear?.(
    ({ ptyId }) => {
      useAppStore.getState().clearMigrationUnsupportedPty(ptyId)
    }
  )
  if (unsubscribeMigrationUnsupportedClear) {
    unsubs.push(unsubscribeMigrationUnsupportedClear)
  }
  const unsubscribeLegacyWorkerTerminalRecovery =
    window.api.agentStatus.onLegacyWorkerTerminalRecovery?.((event) => {
      const action = resolveLegacyWorkerTerminalRecoveryAction(event)
      if (action.kind === 'rollback-surface') {
        window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail: action.detail }))
        rollbackLegacyWorkerTerminalSurfaceInStore(useAppStore.getState(), action.detail)
      } else if (action.kind === 'clear-sleeping') {
        useAppStore.getState().clearSleepingAgentSession(action.paneKey)
      }
    })
  if (unsubscribeLegacyWorkerTerminalRecovery) {
    unsubs.push(unsubscribeLegacyWorkerTerminalRecovery)
  }
}
