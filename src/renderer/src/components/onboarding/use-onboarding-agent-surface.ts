import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatDefaultFor } from '../../../../shared/structured-native-chat-launch-route'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import type { ProspectiveWorkspace } from '@/lib/agent-launch-route-input'
import { readChatProgram, resolveChatProgramContext } from '@/lib/host-chat-program'
import { useChatProgramFacts } from '@/lib/host-chat-program-acquisition'
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

// Chat runs on this computer's own host, whatever runtime its workspaces use.
const CHAT_HOST: ProspectiveWorkspace = { kind: 'floating' }

/** Which agents can open as a chat on this computer, and which of those it can run now. */
export function useChatAgentDetection() {
  const refreshNativeDetectedAgents = useAppStore((s) => s.refreshNativeDetectedAgents)
  const refreshLocalAgents = useAppStore((s) => s.refreshDetectedAgents)
  const nativeDetected = useAppStore(readNativeDetectedAgents)
  useHostStructuredAgentsVersion()
  useChatProgramFacts(CHAT_HOST)
  useEffect(() => {
    // Chat UI may still be off, so the background sync has not asked the local host yet.
    void relearnHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, null, undefined)
  }, [])
  const refreshDetectedAgents = useCallback(
    (...args: Parameters<typeof refreshLocalAgents>) => {
      const refresh = refreshLocalAgents(...args)
      // Joins the refresh on native hosts; under WSL it re-reads the separate native inventory.
      void refreshNativeDetectedAgents()
      return refresh
    },
    [refreshLocalAgents, refreshNativeDetectedAgents]
  )
  // Claude and Codex, then the agents this computer's host registered for chat.
  const chatAgents = chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
  // Custom commands and downloaded runtimes can run Chat without a CLI on PATH.
  const chatReady = useAppStore((state) => {
    const context = resolveChatProgramContext(state, CHAT_HOST)
    return chatAgents
      .filter((agent) => readChatProgram(state, agent, context, nativeDetected) === 'available')
      .join(',')
  })
  // Chat never runs in WSL, so only native installs count; null while detection is pending.
  const chatDetected =
    nativeDetected === null
      ? null
      : chatAgents.filter(
          (agent) => nativeDetected.includes(agent) || chatReady.split(',').includes(agent)
        )
  return { chatAgents, chatDetected, refreshDetectedAgents }
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

  const { chatAgents, chatDetected, refreshDetectedAgents } = useChatAgentDetection()
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

  return { agentSurface, setAgentSurface, chatAgents, chatDetected, refreshDetectedAgents }
}
