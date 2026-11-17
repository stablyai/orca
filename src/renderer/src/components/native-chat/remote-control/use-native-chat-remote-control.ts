import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type {
  AgentSessionProviderRemoteControl,
  AgentSessionProviderRemoteControlChoice,
  AgentSessionProviderRemoteControlResult
} from '../../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type NativeChatRemoteControl = {
  /** The running agent's link as its host last published it; absent while off. */
  link: AgentSessionProviderRemoteControl | undefined
  /** The chat's saved choice; absent follows the setting. */
  choice: AgentSessionProviderRemoteControlChoice | undefined
  /** Absent until the host is known to save the choice; an older host never shows the control. */
  set?: (choice: AgentSessionProviderRemoteControlChoice) => Promise<{ live: boolean }>
}

/** A Claude chat's Remote Control, read from the status feed every device shares. */
export function useNativeChatRemoteControl(
  target: RuntimeClientTarget,
  sessionId: string
): NativeChatRemoteControl {
  const supported =
    useStructuredAgentSessionHostCapabilityState(
      target,
      AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY
    ) === 'supported'
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => (supported ? feed.activate() : undefined), [supported, feed])
  const subscribe = useCallback(
    (listener: () => void) => feed.subscribeSession(sessionId, listener),
    [feed, sessionId]
  )
  const link = useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.providerRemoteControl
  )
  const choice = useSyncExternalStore(
    subscribe,
    () => feed.getSnapshot().get(sessionId)?.providerRemoteControlChoice
  )
  const set = useCallback(
    async (next: AgentSessionProviderRemoteControlChoice) => {
      const result = await callStructuredAgentSession<AgentSessionProviderRemoteControlResult>(
        target,
        'agentSession.providerRemoteControl',
        { sessionId, choice: next }
      )
      if (result.status !== 'ok') {
        throw new Error('This agent does not support Remote Control.')
      }
      return { live: result.live }
    },
    [target, sessionId]
  )
  return useMemo(
    () => ({ link, choice, ...(supported ? { set } : {}) }),
    [link, choice, supported, set]
  )
}
