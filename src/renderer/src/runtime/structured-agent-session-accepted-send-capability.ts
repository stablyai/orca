import { useLayoutEffect, useRef, type RefObject } from 'react'
import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from './runtime-client-target'
import {
  structuredAgentSessionHostKey,
  useStructuredAgentSessionHostCapability
} from './structured-agent-session-host-capability'

/**
 * Whether the host answers a send at acceptance and never refuses one because its agent could not
 * start. Such a host records every send before it starts anything, so nothing about a moved fence
 * calls for a resend. False until the host has said so: an older host is handled as it always was.
 */
export function useStructuredAgentSessionHostAcceptsSend(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
  )
}

/**
 * When an outbox treats its owner as changed: resending a send in flight under the same id,
 * dropping that send's answer, and unblocking a refused head. An older host restarts the agent
 * inside the send and refuses it, unrecorded, when that fails, so a new fence is its only word that
 * another try may land. A host that accepts first records every send before it starts anything,
 * so a moved fence means nothing there, and only a Retry or a new send goes out.
 */
export function useStructuredAgentSessionOutboxOwnerChange(
  target: RuntimeClientTarget,
  fence: number | null
): {
  ownerChange: number | null
  attached: boolean
  fenceRef: RefObject<number | null>
  targetKey: string
} {
  const acceptsSend = useStructuredAgentSessionHostAcceptsSend(target)
  // Read by effects that run on an owner change, not on every fence move.
  const fenceRef = useRef(fence)
  useLayoutEffect(() => {
    fenceRef.current = fence
  }, [fence])
  return {
    ownerChange: acceptsSend ? null : fence,
    attached: fence !== null,
    fenceRef,
    targetKey: structuredAgentSessionHostKey(target)
  }
}
