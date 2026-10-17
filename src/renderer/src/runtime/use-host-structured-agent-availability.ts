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
  worktreeId: string
  /** Changes on reconnect or re-pair, which reopens a lost stream. */
  contact: string
}

/** The workspace's availability readiness, its stream held while the caller is mounted rather
 *  than while a menu is open, so no open waits on it. Null for a host that does not publish it. */
export function useHostStructuredAgentAvailability(
  owner: AvailabilityOwner | null
): HostStructuredAgentAvailability | null {
  const { executionHostId = '', runtimeId, worktreeId = '', contact } = owner ?? {}
  const read = useCallback(
    () => readHostStructuredAgentAvailability(executionHostId, runtimeId, worktreeId),
    [executionHostId, runtimeId, worktreeId]
  )
  const availability = useSyncExternalStore(subscribeHostStructuredAgentAvailability, read, read)
  const held = owner !== null
  useEffect(() => {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    if (!held || !target || runtimeId === undefined) {
      return
    }
    return acquireHostStructuredAgentAvailability({
      target,
      executionHostId,
      runtimeId,
      worktreeId
    })
  }, [held, executionHostId, runtimeId, worktreeId, contact])
  return held ? availability : null
}
