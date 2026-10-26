import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { notifyStructuredAttentionView } from '@/attention/agent-subject-read-actions'
import { structuredAttentionReadObservation } from './structured-attention-read-observation'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  getStructuredAgentSessionReadOwner,
  type StructuredAgentSessionReadSnapshot
} from './structured-agent-session-read-owner'
import {
  adoptStructuredReadOwner,
  findStructuredAgentSessionReadOwner,
  structuredReadOwnerKey
} from './structured-agent-session-read-owner-registry'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'

const emptySnapshot: StructuredAgentSessionReadSnapshot = {
  state: EMPTY_STRUCTURED_AGENT_SESSION,
  loadingOlder: false,
  olderHistoryGeneration: 0,
  current: false
}
const loadUnboundOlder = () => Promise.resolve('superseded' as const)

function useReadOwnerSnapshot(
  sessionId: string,
  target: RuntimeClientTarget
): {
  owner: ReturnType<typeof findStructuredAgentSessionReadOwner>
  snapshot: StructuredAgentSessionReadSnapshot
} {
  const binding = useMemo(() => {
    let candidate: ReturnType<typeof findStructuredAgentSessionReadOwner>
    let token = { owner: candidate, snapshot: emptySnapshot }
    return {
      getSnapshot: () => {
        const current = findStructuredAgentSessionReadOwner(sessionId, target)
        const owner = current?.lifetime.retired ? undefined : current
        const snapshot = owner?.getSnapshot() ?? emptySnapshot
        if (token.owner !== owner || token.snapshot !== snapshot) {
          token = { owner, snapshot }
        }
        return token
      },
      subscribe: (listener: () => void, selected: typeof candidate) => {
        let current = findStructuredAgentSessionReadOwner(sessionId, target)
        const idle = selected ?? candidate
        if (
          !current &&
          idle &&
          adoptStructuredReadOwner(structuredReadOwnerKey(sessionId, target), idle)
        ) {
          current = idle
        }
        candidate = current ?? getStructuredAgentSessionReadOwner(sessionId, target)
        return candidate.subscribe(listener)
      }
    }
  }, [sessionId, target])
  const selected = binding.getSnapshot().owner
  const subscribe = useCallback(
    (listener: () => void) => binding.subscribe(listener, selected),
    [binding, selected]
  )
  return useSyncExternalStore(subscribe, binding.getSnapshot, binding.getSnapshot)
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
  const observationKey = structuredAttentionReadObservation(snapshot.state)
  const lastView = useRef<{ owner: typeof owner; observationKey: string } | null>(null)

  useEffect(() => (isVisible ? owner?.activate() : undefined), [isVisible, owner])
  useEffect(() => {
    const observedCursor = snapshot.state.cursor
    if (!isViewed) {
      lastView.current = null
      return
    }
    if (
      !observedCursor ||
      (lastView.current?.owner === owner && lastView.current?.observationKey === observationKey)
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
    loadOlder: owner?.loadOlder ?? loadUnboundOlder,
    providerSession: snapshot.providerSession
  }
}
