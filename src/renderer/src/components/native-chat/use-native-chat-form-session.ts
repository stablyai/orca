import { useMemo } from 'react'
import { RUNTIME_ORDINARY_MESSAGE_CAPABILITY } from '../../../../shared/runtime-ordinary-message-capability'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'

export function useNativeChatFormSession(
  { sessionId, target }: { sessionId: string; target: RuntimeClientTarget },
  epoch: string | null
) {
  const ordinaryMessages = useStructuredAgentSessionHostCapabilityState(
    target,
    RUNTIME_ORDINARY_MESSAGE_CAPABILITY
  )
  const settledBodyOwner = useMemo(
    () =>
      target
        ? {
            sessionId,
            epoch,
            reader: getStructuredAgentSessionReadOwner(sessionId, target).settledBodies
          }
        : null,
    [sessionId, target, epoch]
  )
  return { ordinaryMessages, settledBodyOwner }
}
