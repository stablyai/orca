import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { buildNativeChatProviderUpdate } from '../../../../shared/native-chat/native-chat-providers'
import {
  isNativeChatDefaultFor,
  isNativeChatEnabled
} from '../../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { chatProviderAgents } from '@/lib/chat-provider-agents'
import { useAppStore } from '../../store'
import { createAgentSettingsUpdateQueue } from './agent-availability-settings'

// Serialize shared-map writes across Settings rows so rapid flips cannot overwrite each other.
const enqueueProviderUpdate = createAgentSettingsUpdateQueue()

export function saveNativeChatProviderChoice({
  agent,
  on,
  fallbackSettings,
  updateSettings
}: {
  agent: TuiAgent
  on: boolean
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): Promise<void> {
  return enqueueProviderUpdate({
    getSettings: () => useAppStore.getState().settings,
    fallbackSettings,
    updateSettings,
    buildUpdate: (latest) => buildNativeChatProviderUpdate(latest, agent, on)
  })
}

export type AgentOpensAs = {
  value: 'chat' | 'cli'
  /** Chat runs from Orca's downloaded program, so there is no terminal to open. */
  cliMissing: boolean
  onChange: (value: 'chat' | 'cli') => void
}

// This computer's preference also routes paired-host launches, independently of local inventory.
export function buildAgentOpensAs({
  agent,
  cliDetected,
  chatProgramHere,
  settings,
  updateSettings
}: {
  agent: TuiAgent
  cliDetected: boolean | null
  chatProgramHere: boolean
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): AgentOpensAs | undefined {
  const offered =
    isNativeChatEnabled(settings) &&
    chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined).includes(agent) &&
    isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  if (!offered) {
    return undefined
  }
  return {
    // Matches launch: an unchosen agent opens as a chat.
    value: isNativeChatDefaultFor(settings, agent) ? 'chat' : 'cli',
    cliMissing: chatProgramHere && cliDetected === false,
    onChange: (value) =>
      void saveNativeChatProviderChoice({
        agent,
        on: value === 'chat',
        fallbackSettings: settings,
        updateSettings
      })
  }
}
