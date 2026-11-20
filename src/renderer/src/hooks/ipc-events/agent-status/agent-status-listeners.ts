import { CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import {
  resolveLegacyWorkerTerminalRecoveryAction,
  rollbackLegacyWorkerTerminalSurfaceInStore
} from '../../../lib/agent-session/resume/legacy-worker-terminal-recovery-event'
import { useAppStore } from '../../../store/index'
import {
  forgetRefusedPaneResume,
  namesConversation
} from '@/lib/agent-session/resume/forget-refused-pane-resume'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-status/pane-authority/agent-pane-authority'
import { resolvePaneKey } from '../../../lib/agent-status/ownership/agent-status-pane-ownership'
import { isAgentSessionSlotTabId } from '../../../../../shared/agent-session/view/agent-session-slot-tab-id'
import { isReopenedChatTabId } from '../../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { structuredAgentSessionIdOfTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { PendingAgentStatusEvent } from './agent-status-bridge-types'

function isStructuredSessionPane(paneKey: string, existing: AgentStatusEntry | undefined): boolean {
  if (existing?.terminalResumeEligible === false || existing?.structuredHostOwned === true) {
    return true
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  return (
    structuredAgentSessionIdOfTab(parsed.tabId) !== null ||
    isReopenedChatTabId(parsed.tabId) ||
    isAgentSessionSlotTabId(parsed.tabId)
  )
}

/** An already delivered event for the pane naming a refused conversation would restore it. */
function dropEventsRestoringRefused(
  paneKey: string,
  refused: RefusedPaneResume,
  queues: {
    pendingAgentStatusEvents: PendingAgentStatusEvent[]
    liveAgentStatusBurstQueue: AgentStatusIpcPayload[]
  }
): void {
  const restores = (event: AgentStatusIpcPayload): boolean =>
    !!refused.expectedStatus &&
    event.receivedAt <= refused.expectedStatus.receivedAt &&
    event.stateStartedAt === refused.expectedStatus.stateStartedAt &&
    resolveAgentPaneAuthorityKey(event.paneKey) === paneKey &&
    namesConversation(refused, { ...event, agent: event.agentType })
  const pending = queues.pendingAgentStatusEvents
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (restores(pending[index].data)) {
      pending.splice(index, 1)
    }
  }
  const burst = queues.liveAgentStatusBurstQueue
  for (let index = burst.length - 1; index >= 0; index -= 1) {
    if (restores(burst[index])) {
      burst.splice(index, 1)
    }
  }
}

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
      // A successful stop can resolve before the ordinary burst timer; publish its handoff first.
      if (data.paneSleep) {
        drainQueuedLiveAgentStatusesForPane(data.paneKey)
      }
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
            !pending.paneSleep &&
            pending.connectionId === data.connectionId &&
            pending.receivedAt <= effectiveWatermark
          ) {
            pendingAgentStatusEvents.splice(index, 1)
          }
        }
        for (let index = liveAgentStatusBurstQueue.length - 1; index >= 0; index -= 1) {
          const queued = liveAgentStatusBurstQueue[index]
          if (
            !queued.paneSleep &&
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
      if (data.refusedResume) {
        dropEventsRestoringRefused(data.paneKey, data.refusedResume, {
          pendingAgentStatusEvents,
          liveAgentStatusBurstQueue
        })
        forgetRefusedPaneResume(useAppStore.getState(), data.paneKey, data.refusedResume)
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
      const existing = store.agentStatusByPaneKey.get(data.paneKey)
      if (
        data.statusUnavailable !== true &&
        data.programStatusRemoved !== true &&
        !existing?.paneSleep &&
        existing?.state === 'done' &&
        resolvePaneKey(store, data.paneKey).exists
      ) {
        return
      }
      store.removeAgentStatus(
        data.paneKey,
        isStructuredSessionPane(data.paneKey, existing)
          ? { preserveActivityState: true }
          : undefined
      )
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
