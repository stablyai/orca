import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isNativeChatDefaultFor } from '../../../../shared/structured-native-chat-launch-route'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { relearnHostStructuredAgents } from '@/runtime/host-structured-agents'
import { useAppStore } from '@/store'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import type { AgentSurface } from './use-onboarding-flow-types'

type AgentSurfaceArgs = {
  settings: GlobalSettings | null
  selectedAgent: TuiAgent | null
  agentInteractedRef: { readonly current: boolean }
  setSelectedAgent: Dispatch<SetStateAction<TuiAgent | null>>
}

export function useOnboardingAgentSurface({
  settings,
  selectedAgent,
  agentInteractedRef,
  setSelectedAgent
}: AgentSurfaceArgs) {
  // Unchosen, the page reflects the saved Chat UI setting, including once settings hydrate.
  const [choice, setAgentSurface] = useState<AgentSurface | null>(null)
  const agentSurface: AgentSurface =
    choice ?? (settings?.experimentalNativeChat === true ? 'chat' : 'terminal')

  const ensureNativeDetectedAgents = useAppStore((s) => s.ensureNativeDetectedAgents)
  const nativeDetected = useAppStore(readNativeDetectedAgents)
  useHostStructuredAgentsVersion()
  useEffect(() => {
    void ensureNativeDetectedAgents()
    // Chat UI is usually still off here, so the background sync has not asked the local host yet.
    void relearnHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, null, undefined)
  }, [ensureNativeDetectedAgents])
  // Claude and Codex, then the agents this computer's host registered for chat.
  const chatAgents = chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
  // Chat never runs in WSL, so only native installs count; null while detection is pending.
  const chatDetected = nativeDetected?.filter((agent) => chatAgents.includes(agent)) ?? null
  const chatSettings = {
    experimentalNativeChat: true,
    nativeChatProviders: settings?.nativeChatProviders
  }
  const selectedAgentOpensAsChat =
    selectedAgent !== null &&
    chatDetected?.includes(selectedAgent) === true &&
    isNativeChatDefaultFor(chatSettings, selectedAgent)
  const installedChatAgent = chatAgents.find(
    (agent) => chatDetected?.includes(agent) && isNativeChatDefaultFor(chatSettings, agent)
  )

  useEffect(() => {
    if (
      choice === 'chat' &&
      !agentInteractedRef.current &&
      !selectedAgentOpensAsChat &&
      installedChatAgent
    ) {
      setSelectedAgent(installedChatAgent)
    }
  }, [choice, agentInteractedRef, installedChatAgent, selectedAgentOpensAsChat, setSelectedAgent])

  return { agentSurface, setAgentSurface, chatAgents, chatDetected }
}
