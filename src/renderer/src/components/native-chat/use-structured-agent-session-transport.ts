import { useEffect, useRef } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import { useUndeliveredStructuredAgentSessionOutbox } from './use-undelivered-structured-agent-session-outbox'

export function useStructuredAgentSessionTransport(args: {
  sessionId: string
  target: RuntimeClientTarget
  isVisible: boolean
  enabled: boolean
}) {
  const { enabled, isVisible, sessionId, target } = args
  const providerVisible = isVisible && enabled
  useStructuredAgentSessionHold({
    sessionId,
    target,
    surface: 'desktop-chat',
    enabled: providerVisible
  })
  // A worktree switch hides the pane, but a message the user already sent is still owed a
  // delivery, and the read is what carries the journal rows that retire it. Gated on `enabled`:
  // a session not yet published has nothing to read. Attention is not the signal; owed work is.
  const hasUndelivered = useUndeliveredStructuredAgentSessionOutbox(sessionId)
  const read = useStructuredAgentSessionRead({
    sessionId,
    target,
    isVisible: providerVisible || (enabled && hasUndelivered)
  })
  const stateRef = useRef(read.state)
  const mutation = useStructuredAgentSessionMutate({
    sessionId,
    target,
    stateRef,
    enabled
  })
  useEffect(() => {
    stateRef.current = read.state
  }, [read.state])
  return { ...read, ...mutation, providerVisible }
}
