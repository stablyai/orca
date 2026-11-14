import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  getStructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedOwner
} from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { structuredAgentSessionOptionStamp } from '../../../../../../shared/agent-session/options/reconciliation/structured-agent-session-option-state'
import { runtimePermissionReport } from '../../../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'

/** The host feed plus a subscription that wakes only for this chat's updates. */
function useSessionFeed(
  sessionId: string,
  target: RuntimeClientTarget
): {
  feed: StructuredAgentSessionStatusFeedOwner
  subscribe: (listener: () => void) => () => void
} {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  const subscribe = useCallback(
    (listener: () => void) => feed.subscribeSession(sessionId, listener),
    [feed, sessionId]
  )
  return { feed, subscribe }
}

/** Option state reads only the permission answer and observation, so other summary fields never re-render the chat. */
export function useStructuredAgentSessionPermissionStatus(
  sessionId: string,
  target: RuntimeClientTarget,
  fence: number | null
): {
  permissionReport: ReturnType<typeof runtimePermissionReport>
  observation: 'live' | 'unverifiable'
} {
  const { feed, subscribe } = useSessionFeed(sessionId, target)
  const permissionReport = useSyncExternalStore(
    subscribe,
    () => runtimePermissionReport(feed.getSnapshot().get(sessionId), fence),
    () => runtimePermissionReport(undefined, fence)
  )
  const observation = useSyncExternalStore(
    subscribe,
    () => feed.getSessionObservation(sessionId),
    () => 'unverifiable' as const
  )
  return { permissionReport, observation }
}

export function useStructuredAgentSessionOptionStamp(
  sessionId: string,
  target: RuntimeClientTarget
): string {
  const { feed, subscribe } = useSessionFeed(sessionId, target)
  return useSyncExternalStore(
    subscribe,
    () => structuredAgentSessionOptionStamp(feed.getSnapshot().get(sessionId)),
    () => ''
  )
}

/** Subscribe only to startup phase changes, avoiding unrelated status renders. */
export function useStructuredAgentSessionHostExecutionPhase(
  sessionId: string,
  target: RuntimeClientTarget
): NonNullable<AgentSessionStatusSummary['hostExecutionPhase']> | null {
  const { feed, subscribe } = useSessionFeed(sessionId, target)
  return useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.hostExecutionPhase ?? null,
    () => null
  )
}

/** Whether the host says this chat runs a program the host already has; an older host never does. */
export function useStructuredAgentSessionHostProgram(
  sessionId: string,
  target: RuntimeClientTarget
): boolean {
  const { feed, subscribe } = useSessionFeed(sessionId, target)
  return useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.hostProgram === true,
    () => false
  )
}

/** Whether the host says a person's Stop is still ending the work; an older host never does. */
export function useStructuredAgentSessionHostStopping(
  sessionId: string,
  target: RuntimeClientTarget
): boolean {
  const { feed, subscribe } = useSessionFeed(sessionId, target)
  return useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.stopping === true,
    () => false
  )
}

export function useStructuredAgentSessionHostExecution(
  sessionId: string,
  target: RuntimeClientTarget
): {
  phase: ReturnType<typeof useStructuredAgentSessionHostExecutionPhase>
  stopping: boolean
  optionStamp: string
} {
  return {
    phase: useStructuredAgentSessionHostExecutionPhase(sessionId, target),
    stopping: useStructuredAgentSessionHostStopping(sessionId, target),
    optionStamp: useStructuredAgentSessionOptionStamp(sessionId, target)
  }
}

/** Subscribe only to rewind recovery changes, avoiding unrelated status renders. */
export function useStructuredAgentSessionRewindBlockedReason(
  sessionId: string,
  target: RuntimeClientTarget
): NonNullable<AgentSessionStatusSummary['rewindBlockedReason']> | null {
  const { feed, subscribe } = useSessionFeed(sessionId, target)
  return useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.rewindBlockedReason ?? null,
    () => null
  )
}
