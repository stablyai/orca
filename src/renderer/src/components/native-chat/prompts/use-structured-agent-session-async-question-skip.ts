import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionAwaitedQuestion } from '../../../../../shared/agent-session/agent-session-wire'

export type StructuredAgentSessionAsyncQuestionSkip = {
  skippedThrough: string | undefined
  /** The open question the host waits on, unskipped, for a screen that has not loaded its row. */
  awaiting: AgentSessionAwaitedQuestion | undefined
  /** Absent until the host is known to save Skip; an older host leaves it to this screen. */
  save?: (itemId: string) => Promise<unknown>
}

/** The chat's Skip as its host saved it, and the question it waits on, read from the status feed. */
export function useStructuredAgentSessionAsyncQuestionSkip(
  target: RuntimeClientTarget,
  sessionId: string
): StructuredAgentSessionAsyncQuestionSkip {
  const supported =
    useStructuredAgentSessionHostCapabilityState(
      target,
      AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY
    ) === 'supported'
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => (supported ? feed.activate() : undefined), [supported, feed])
  const subscribe = useCallback(
    (listener: () => void) => feed.subscribeSession(sessionId, listener),
    [feed, sessionId]
  )
  const skippedThrough = useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.asyncQuestionsSkippedThrough
  )
  const awaiting = useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.awaitsQuestion
  )
  const save = useCallback(
    (itemId: string) =>
      callStructuredAgentSession(target, 'agentSession.skipAsyncQuestions', { sessionId, itemId }),
    [target, sessionId]
  )
  return useMemo(
    () => ({ skippedThrough, awaiting, ...(supported ? { save } : {}) }),
    [supported, skippedThrough, awaiting, save]
  )
}
