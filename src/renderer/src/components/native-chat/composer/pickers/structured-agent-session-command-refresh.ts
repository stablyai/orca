import { useCallback, useEffect, useRef, useState } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { AgentSessionCommandsResult } from '../../../../../../shared/agent-session/agent-session-wire'
import { startAgentSessionCommandMenuQuery } from '../../../../../../shared/agent-session/agent-session-command-menu-query'
import { getStructuredAgentSessionReadOwner } from '../../session/structured/read/structured-agent-session-read-owner'

export function useStructuredAgentSessionCommandMenu(
  target: RuntimeClientTarget,
  sessionId: string,
  enabled: boolean
) {
  const [open, setOpen] = useState(false)
  const query = useRef<ReturnType<typeof startAgentSessionCommandMenuQuery> | null>(null)
  useEffect(() => {
    if (!enabled || !open) {
      return
    }
    const owned = startAgentSessionCommandMenuQuery(
      () =>
        callStructuredAgentSession<AgentSessionCommandsResult>(target, 'agentSession.commands', {
          sessionId
        }),
      () => {}
    )
    query.current = owned
    const stop = getStructuredAgentSessionReadOwner(sessionId, target).subscribeCommandsChanged(
      owned.invalidate
    )
    return () => {
      stop()
      query.current = null
      owned.dispose()
    }
  }, [enabled, open, sessionId, target])
  const refresh = useCallback(() => query.current?.invalidate(), [])
  return { setOpen, refresh }
}
