import { useSyncExternalStore } from 'react'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-state-store'

/** Unknown capability keeps Stop unavailable until create can publish or choose the old flow. */
export function useStructuredLaunchCreateSupport(sessionId: string): boolean | undefined {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () =>
      getStructuredLaunchStateBySessionId(sessionId)?.intent.createMessageSupport ??
      getPersistedStructuredAgentLaunchRecord(sessionId)?.createMessageSupport,
    () => undefined
  )
}
