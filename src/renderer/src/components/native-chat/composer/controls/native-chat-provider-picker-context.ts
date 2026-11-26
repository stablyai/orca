import { useTranslate } from '@/i18n/use-translate'
import { tuiAgentDisplayName } from '../../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { useStructuredAgentSessionSelectedProvider } from '../../session/status/structured-agent-session-status-hooks'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { createContext, useContext, useMemo } from 'react'
import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type NativeChatProviderPickerScope = {
  sessionId: string
  target: RuntimeClientTarget
  workspaceId: string
  selected: AgentSessionStatusSummary['selectedProvider']
  onError: (message: string) => void
}

export const NativeChatProviderPickerContext = createContext<NativeChatProviderPickerScope | null>(
  null
)

export function useNativeChatProviderPickerScope(
  {
    sessionId,
    target,
    isVisible
  }: { sessionId: string; target: RuntimeClientTarget; isVisible: boolean },
  workspaceId: string | null | undefined,
  transportEnabled: boolean,
  onError: NativeChatProviderPickerScope['onError']
): NativeChatProviderPickerScope | null {
  const scopeTarget = isVisible ? target : null
  const supported =
    useStructuredAgentSessionHostCapabilityState(
      scopeTarget,
      AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY
    ) === 'supported'
  const selected = useStructuredAgentSessionSelectedProvider(sessionId, target)
  return useMemo(
    () =>
      supported && workspaceId && transportEnabled
        ? { sessionId, target, workspaceId, selected, onError }
        : null,
    [supported, workspaceId, transportEnabled, sessionId, target, selected, onError]
  )
}

export function useNativeChatNextAgent() {
  const nextAgent = useContext(NativeChatProviderPickerContext)?.selected?.agent
  const t = useTranslate()
  const nextAgentPlaceholder = nextAgent
    ? t('chat.providerSwitch.nextMessage', 'Message {{agent}}…', {
        agent: tuiAgentDisplayName(nextAgent) ?? nextAgent
      })
    : undefined
  return { nextAgent, nextAgentPlaceholder }
}
