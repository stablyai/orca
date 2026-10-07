import { useCallback, useSyncExternalStore } from 'react'
import {
  hasUndeliveredStructuredAgentSessionOutbox,
  subscribeToUndeliveredStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'

/** Whether this session still owes a delivery, so a caller can keep working on it after the
 *  user's attention has moved elsewhere. */
export function useUndeliveredStructuredAgentSessionOutbox(sessionId: string): boolean {
  const getUndelivered = useCallback(
    () => hasUndeliveredStructuredAgentSessionOutbox(sessionId),
    [sessionId]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeToUndeliveredStructuredAgentSessionOutbox(sessionId, listener),
    [sessionId]
  )
  return useSyncExternalStore(subscribe, getUndelivered, getUndelivered)
}
