import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  acquireHostStructuredAgentAvailability,
  readHostStructuredAgentAvailability,
  subscribeHostStructuredAgentAvailability,
  type HostStructuredAgentAvailability
} from './host-structured-agent-availability'
import { structuredAgentSessionTargetForHost } from './structured-agent-session-owner'

type AvailabilityOwner = {
  executionHostId: string
  runtimeId: string | null | undefined
  pairingRevision: number | undefined
  /** Changes on reconnect, which reopens a lost stream without dropping the snapshot. */
  contact: string
  /** Whether this caller holds the stream open; the last snapshot is read either way. */
  hold: boolean
}

/** The host's agent health snapshot, with no workspace in it, so switching between workspaces on
 *  one host reads what it already has. Null for a host that does not publish it. */
export function useHostStructuredAgentAvailability(
  owner: AvailabilityOwner | null
): HostStructuredAgentAvailability | null {
  const { executionHostId = '', runtimeId, pairingRevision, contact, hold = false } = owner ?? {}
  const read = useCallback(
    () => readHostStructuredAgentAvailability(executionHostId, runtimeId, pairingRevision),
    [executionHostId, runtimeId, pairingRevision]
  )
  const availability = useSyncExternalStore(subscribeHostStructuredAgentAvailability, read, read)
  useEffect(() => {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    if (!hold || !target || runtimeId === undefined) {
      return
    }
    return acquireHostStructuredAgentAvailability({
      target,
      executionHostId,
      runtimeId,
      pairingRevision
    })
  }, [hold, executionHostId, runtimeId, pairingRevision, contact])
  return owner ? availability : null
}
