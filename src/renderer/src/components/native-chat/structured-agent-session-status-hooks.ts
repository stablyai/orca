import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

/** The host's projected status for one session, live while the caller is mounted. */
export function useStructuredAgentSessionStatusSummary(
  sessionId: string,
  target: RuntimeClientTarget
): { summary: AgentSessionStatusSummary | null; observation: 'live' | 'unverifiable' } {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  const summary = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId) ?? null,
    () => null
  )
  const observation = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSessionObservation(sessionId),
    () => 'unverifiable' as const
  )
  return { summary, observation }
}

/** The host status's option values as one stamp: another device's pick moves it, so options re-read. */
export function useStructuredAgentSessionOptionStamp(
  sessionId: string,
  target: RuntimeClientTarget
): string {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => {
      const summary = feed.getSnapshot().get(sessionId)
      return `${summary?.model ?? ''}|${summary?.permissionMode ?? ''}`
    },
    () => ''
  )
}

/** Only the host's startup phase, so a chat re-renders when that changes, not on every status. */
export function useStructuredAgentSessionHostExecutionPhase(
  sessionId: string,
  target: RuntimeClientTarget
): NonNullable<AgentSessionStatusSummary['hostExecutionPhase']> | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId)?.hostExecutionPhase ?? null,
    () => null
  )
}

/** Whether the host says a person's Stop is still ending the work; an older host never does. */
export function useStructuredAgentSessionHostStopping(
  sessionId: string,
  target: RuntimeClientTarget
): boolean {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId)?.stopping === true,
    () => false
  )
}

/** Startup phase, Stop and option stamp, each re-rendering the chat only on a change. */
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

/** Only the host's rewind recovery latch, so a chat re-renders when that changes, not on every status. */
export function useStructuredAgentSessionRewindBlockedReason(
  sessionId: string,
  target: RuntimeClientTarget
): NonNullable<AgentSessionStatusSummary['rewindBlockedReason']> | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId)?.rewindBlockedReason ?? null,
    () => null
  )
}
