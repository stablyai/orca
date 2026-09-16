import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getStructuredAgentSessionReadOwner,
  type StructuredAgentSessionReadSnapshot
} from './structured-agent-session-read-owner'

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

  useEffect(() => (isVisible ? owner.activate() : undefined), [isVisible, owner])

  return {
    state: snapshot.state,
    loadingOlder: snapshot.loadingOlder,
    loadOlder: owner.loadOlder,
    providerSession: snapshot.providerSession
  }
}
