import { useSyncExternalStore } from 'react'
import {
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-state-store'
import { readStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'

/** Unknown capability keeps Stop unavailable until create can publish or choose the old flow. */
export function useStructuredLaunchCreateSupport(sessionId: string): boolean | undefined {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () =>
      getStructuredLaunchStateBySessionId(sessionId)?.intent.createMessageSupport ??
      readStructuredAgentLaunchRecord(sessionId)?.createMessageSupport,
    () => undefined
  )
}
