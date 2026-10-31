import { useAppStore } from '@/store'
import {
  isAgentTaskCompleteOsNotificationEnabledFromState,
  isAgentTaskCompleteTrackingEnabledFromState
} from '../agent-task-complete-policy'

export function isAgentTaskCompleteNotificationEnabled(): boolean {
  return isAgentTaskCompleteOsNotificationEnabledFromState(useAppStore.getState())
}

export function isAgentTaskCompleteTrackingEnabled(): boolean {
  return isAgentTaskCompleteTrackingEnabledFromState(useAppStore.getState())
}

const agentTaskCompleteTrackingEnabledListeners = new Set<() => void>()
let agentTaskCompleteTrackingSettingsUnsubscribe: (() => void) | null = null
let agentTaskCompleteTrackingSettingsSnapshot: string | null = null

function getAgentTaskCompleteTrackingSettingsSnapshot(
  state: ReturnType<typeof useAppStore.getState>
): string {
  return `${isAgentTaskCompleteTrackingEnabledFromState(state)}:${isAgentTaskCompleteOsNotificationEnabledFromState(state)}`
}

export function subscribeAgentTaskCompleteTrackingEnabled(listener: () => void): () => void {
  if (agentTaskCompleteTrackingSettingsUnsubscribe === null) {
    agentTaskCompleteTrackingSettingsSnapshot = getAgentTaskCompleteTrackingSettingsSnapshot(
      useAppStore.getState()
    )
    agentTaskCompleteTrackingSettingsUnsubscribe = useAppStore.subscribe((state) => {
      const snapshot = getAgentTaskCompleteTrackingSettingsSnapshot(state)
      if (snapshot === agentTaskCompleteTrackingSettingsSnapshot) {
        return
      }
      agentTaskCompleteTrackingSettingsSnapshot = snapshot
      for (const subscriber of Array.from(agentTaskCompleteTrackingEnabledListeners)) {
        subscriber()
      }
    })
  }

  agentTaskCompleteTrackingEnabledListeners.add(listener)
  return () => {
    agentTaskCompleteTrackingEnabledListeners.delete(listener)
    if (
      agentTaskCompleteTrackingEnabledListeners.size === 0 &&
      agentTaskCompleteTrackingSettingsUnsubscribe !== null
    ) {
      agentTaskCompleteTrackingSettingsUnsubscribe()
      agentTaskCompleteTrackingSettingsUnsubscribe = null
      agentTaskCompleteTrackingSettingsSnapshot = null
    }
  }
}
