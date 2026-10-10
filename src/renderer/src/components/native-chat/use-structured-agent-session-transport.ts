import { useEffect, useRef } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'

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
  // A message sent from here is settled by its own reply, so a hidden pane reads nothing.
  const read = useStructuredAgentSessionRead({ sessionId, target, isVisible: providerVisible })
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
  // `stateRef`: the read state now, for a reply that lands after the render that sent it.
  return { ...read, ...mutation, providerVisible, stateRef }
}
