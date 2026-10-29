import { useSyncExternalStore } from 'react'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

/** Read failure time from memory or persisted record; undefined before failure or for older records without timestamps. */
export function getStructuredAgentSessionLaunchFailedAt(sessionId: string): number | undefined {
  return (
    getStructuredLaunchStateBySessionId(sessionId)?.callers.failedAt ??
    getPersistedStructuredAgentLaunchRecord(sessionId)?.failedAt
  )
}

export function useStructuredAgentSessionLaunchFailedAt(sessionId: string): number | undefined {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchFailedAt(sessionId),
    () => undefined
  )
}
