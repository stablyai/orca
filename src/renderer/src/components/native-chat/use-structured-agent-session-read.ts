import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getStructuredAgentSessionReadOwner,
  type StructuredAgentSessionReadSnapshot
} from './structured-agent-session-read-owner'
import {
  hasUndeliveredStructuredAgentSessionOutbox,
  subscribeToUndeliveredStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'

function useReadOwnerSnapshot(
  sessionId: string,
  target: RuntimeClientTarget
): {
  owner: ReturnType<typeof getStructuredAgentSessionReadOwner>
  snapshot: StructuredAgentSessionReadSnapshot
} {
  const owner = useMemo(
    () => getStructuredAgentSessionReadOwner(sessionId, target),
    [sessionId, target]
  )
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
  return { owner, snapshot }
}

export function useStructuredAgentSessionRead(args: {
  sessionId: string
  target: RuntimeClientTarget
  isVisible?: boolean
}) {
  const { sessionId, target, isVisible = true } = args
  const { owner, snapshot } = useReadOwnerSnapshot(sessionId, target)
  const getUndelivered = useCallback(
    () => hasUndeliveredStructuredAgentSessionOutbox(sessionId),
    [sessionId]
  )
  const hasUndelivered = useSyncExternalStore(
    subscribeToUndeliveredStructuredAgentSessionOutbox,
    getUndelivered,
    getUndelivered
  )

  // A subscription also takes a retaining hold on the host, so this both restores the
  // submissions that retire an outbox entry and keeps the session from being evicted
  // out from under a message the user already sent.
  useEffect(
    () => (isVisible || hasUndelivered ? owner.activate() : undefined),
    [hasUndelivered, isVisible, owner]
  )

  return {
    state: snapshot.state,
    loadingOlder: snapshot.loadingOlder,
    loadOlder: owner.loadOlder,
    providerSession: snapshot.providerSession
  }
}
