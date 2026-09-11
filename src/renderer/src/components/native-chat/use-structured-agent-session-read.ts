import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getStructuredAgentSessionReadOwner,
  type StructuredAgentSessionReadSnapshot
} from './structured-agent-session-read-owner'

function useReadOwnerSnapshot(
  sessionId: string,
  target: RuntimeClientTarget,
  ownerPairingRevision: number | undefined
): {
  owner: ReturnType<typeof getStructuredAgentSessionReadOwner>
  snapshot: StructuredAgentSessionReadSnapshot
} {
  const owner = useMemo(
    () => getStructuredAgentSessionReadOwner(sessionId, target, ownerPairingRevision),
    [ownerPairingRevision, sessionId, target]
  )
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
  return { owner, snapshot }
}

export function useStructuredAgentSessionRead(args: {
  sessionId: string
  target: RuntimeClientTarget
  ownerPairingRevision?: number
  isVisible?: boolean
}) {
  const { sessionId, target, ownerPairingRevision, isVisible = true } = args
  const { owner, snapshot } = useReadOwnerSnapshot(sessionId, target, ownerPairingRevision)

  useEffect(() => (isVisible ? owner.activate() : undefined), [isVisible, owner])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    const refresh = (): void => {
      if (document.hasFocus()) {
        owner.refresh()
      }
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [isVisible, owner])

  return {
    state: snapshot.state,
    loadingOlder: snapshot.loadingOlder,
    loadOlder: owner.loadOlder,
    providerSession: snapshot.providerSession
  }
}
