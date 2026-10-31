import { useAppStore } from '@/store'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { notifyStructuredAttentionView } from '@/attention/agent-subject-read-actions'
import { structuredAttentionReadObservation } from './structured-attention-read-observation'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
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
  isViewed?: boolean
}) {
  const { sessionId, target, isVisible = true } = args
  const { owner, snapshot } = useReadOwnerSnapshot(sessionId, target)
  const isViewed = args.isViewed ?? isVisible
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const observationKey = structuredAttentionReadObservation(snapshot.state)
  const lastView = useRef<{ owner: typeof owner; observationKey: string } | null>(null)

  useEffect(() => {
    if (isVisible) {
      return owner.activate({
        getState: useAppStore.getState,
        subscribeRetryNow: (retry) =>
          environmentId ? subscribeRuntimeHostContactRegained(environmentId, retry) : () => {}
      })
    }
    return undefined
  }, [isVisible, owner, environmentId])
  useEffect(() => {
    const observedCursor = snapshot.state.cursor
    if (!isViewed) {
      lastView.current = null
      return
    }
    if (
      !observedCursor ||
      (lastView.current?.owner === owner && lastView.current.observationKey === observationKey)
    ) {
      return
    }
    lastView.current = { owner, observationKey }
    notifyStructuredAttentionView({
      sessionId,
      target,
      observedCursor: { ...observedCursor },
      observationKey
    })
  }, [isViewed, observationKey, owner, sessionId, snapshot.state.cursor, target])

  return {
    state: snapshot.state,
    readCurrent: snapshot.current,
    loadingOlder: snapshot.loadingOlder,
    olderHistoryGeneration: snapshot.olderHistoryGeneration,
    loadOlder: owner.loadOlder,
    providerSession: snapshot.providerSession
  }
}
