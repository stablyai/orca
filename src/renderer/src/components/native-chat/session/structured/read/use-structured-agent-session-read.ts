import { useAppStore } from '@/store'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { notifyStructuredAttentionView } from '@/attention/agent-subject-read-actions'
import { structuredAttentionReadObservation } from '../../attention/structured-attention-read-observation'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { getStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
import type { StructuredAgentSessionReadSnapshot } from './structured-agent-session-read-owner-contract'

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
  keepReadingWhileHidden?: boolean
}) {
  const { sessionId, target, isVisible = true } = args
  const { owner, snapshot } = useReadOwnerSnapshot(sessionId, target)
  const isViewed = args.isViewed ?? isVisible
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const observationKey = structuredAttentionReadObservation(snapshot.state)
  const lastView = useRef<{ owner: typeof owner; observationKey: string } | null>(null)
  const keepReading =
    isVisible || (args.keepReadingWhileHidden !== false && snapshot.state.working === true)

  useEffect(() => {
    if (keepReading) {
      return owner.activate({
        getState: useAppStore.getState,
        subscribeRetryNow: (retry) =>
          environmentId ? subscribeRuntimeHostContactRegained(environmentId, retry) : () => {}
      })
    }
    return undefined
  }, [keepReading, owner, environmentId])
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
    initialHistoryAutoLoad: snapshot.initialHistoryAutoLoad,
    loadOlder: owner.loadOlder,
    retainHistory: owner.retainHistory,
    trimHistory: owner.trimHistory,
    providerSession: snapshot.providerSession
  }
}
