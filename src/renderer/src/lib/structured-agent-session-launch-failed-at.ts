import { useSyncExternalStore } from 'react'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

/** When the launch's last attempt failed: in memory, else as saved before a reload. Undefined
 *  while it has not failed, and for records saved by builds that did not keep the time. */
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
