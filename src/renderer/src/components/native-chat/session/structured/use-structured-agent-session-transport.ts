import { useEffect, useRef } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
import { useStructuredAgentSessionMutate } from './writes/use-structured-agent-session-mutate'
import { useStructuredAgentSessionRead } from './read/use-structured-agent-session-read'

export function useStructuredAgentSessionTransport(args: {
  sessionId: string
  target: RuntimeClientTarget
  isVisible: boolean
  enabled: boolean
  agentName?: string
}) {
  const { agentName, enabled, isVisible, sessionId, target } = args
  const providerVisible = isVisible && enabled
  useStructuredAgentSessionHold({
    sessionId,
    target,
    surface: 'desktop-chat',
    enabled: providerVisible
  })
  const read = useStructuredAgentSessionRead({
    sessionId,
    target,
    isVisible: providerVisible,
    keepReadingWhileHidden: enabled
  })
  const stateRef = useRef(read.state)
  const mutation = useStructuredAgentSessionMutate({
    sessionId,
    target,
    stateRef,
    enabled,
    ...(agentName ? { agentName } : {})
  })
  useEffect(() => {
    stateRef.current = read.state
  }, [read.state])
  return { ...read, ...mutation, providerVisible, stateRef }
}
