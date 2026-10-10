import { useSyncExternalStore } from 'react'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

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
