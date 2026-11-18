import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type StructuredAgentSessionAsyncQuestionSkip = {
  skippedThrough: string | undefined
  /** Absent until the host is known to save Skip; an older host leaves it to this screen. */
  save?: (itemId: string) => Promise<unknown>
}

/** The chat's Skip as its host saved it, read from the status feed. */
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
  const skippedThrough = useSyncExternalStore(
    useCallback(
      (listener: () => void) => feed.subscribeSession(sessionId, listener),
      [feed, sessionId]
    ),
    () => feed.getSnapshot().get(sessionId)?.asyncQuestionsSkippedThrough
  )
  const save = useCallback(
    (itemId: string) =>
      callStructuredAgentSession(target, 'agentSession.skipAsyncQuestions', { sessionId, itemId }),
    [target, sessionId]
  )
  return useMemo(
    () => ({ skippedThrough, ...(supported ? { save } : {}) }),
    [supported, skippedThrough, save]
  )
}
