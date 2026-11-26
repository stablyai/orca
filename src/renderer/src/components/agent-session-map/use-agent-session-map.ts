import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { buildAgentSessionMap } from '../../../../shared/agent-session-map/build-agent-session-map'
import type { AgentMap } from '../../../../shared/agent-session-map/agent-session-map-model'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { resolvePaneAgentSessionId } from '../../lib/agent-session/identity/pane-agent-session-id'
import { selectNativeChatRuntimeEnvironmentId } from '../native-chat/pane/ownership/native-chat-runtime-owner'
import { useStructuredAgentSessionRead } from '../native-chat/session/structured/read/use-structured-agent-session-read'

/** Live agent map for one terminal pane: the pane's provider session, read through the
 *  same structured read owner the chat uses, folded into an AgentMap. No new RPC — the
 *  journal comes from agentSession.history + agentSession.subscribe under the hood.
 *  `map` is null while the pane has no provider session to render. */
export function useAgentSessionMap(args: { tabId: string; paneKey: string; isVisible: boolean }): {
  map: AgentMap | null
  sessionId: string | null
} {
  const { tabId, paneKey, isVisible } = args
  const { sessionId, environmentId } = useAppStore(
    useShallow((state) => ({
      sessionId: resolvePaneAgentSessionId(state, paneKey),
      environmentId: selectNativeChatRuntimeEnvironmentId(state, tabId)
    }))
  )
  const hasSession = sessionId !== null
  const target: RuntimeClientTarget = environmentId
    ? { kind: 'environment', environmentId }
    : { kind: 'local' }

  // The read hook must run unconditionally; a pane without a session simply isn't visible.
  const read = useStructuredAgentSessionRead({
    sessionId: sessionId ?? '',
    target,
    isVisible: hasSession && isVisible
  })
  const { state, loadOlder, loadingOlder, retainHistory } = read

  // The map is a whole-session overview, so it needs the full journal, not the
  // initial 300-row window: page back to the start while visible and retain the
  // history so the shared read owner does not trim it.
  useEffect(() => {
    if (!hasSession || !isVisible || state.status !== 'ready') {
      return undefined
    }
    return retainHistory()
  }, [hasSession, isVisible, state.status, retainHistory])
  useEffect(() => {
    if (!hasSession || !isVisible || state.status !== 'ready' || !state.hasOlder || loadingOlder) {
      return
    }
    void loadOlder()
  }, [hasSession, isVisible, state, loadingOlder, loadOlder])

  const map = useMemo(
    () => (hasSession ? buildAgentSessionMap(state.items) : null),
    [hasSession, state.items]
  )
  return { map, sessionId }
}
