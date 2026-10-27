import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { buildNativeChatProviderUpdate } from '../../../../shared/native-chat/native-chat-providers'
import {
  isNativeChatDefaultFor,
  isNativeChatEnabled
} from '../../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentLabel } from '@/lib/agent-catalog'
import { chatProviderAgents } from '@/lib/chat-provider-agents'
import { useAppStore } from '../../store'
import { createAgentSettingsUpdateQueue } from './agent-availability-settings'
import type { DefaultAgentOpensAs } from './AgentDefaultSetting'

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

/** Offer chat/CLI choice only when its stored value agrees with the Providers switch. */
export function buildDefaultAgentOpensAs({
  defaultAgent,
  settings,
  updateSettings,
  installedHere
}: {
  defaultAgent: TuiAgent | 'blank' | null
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  installedHere: readonly TuiAgent[] | null
}): DefaultAgentOpensAs | undefined {
  if (defaultAgent === null || defaultAgent === 'blank' || !isNativeChatEnabled(settings)) {
    return undefined
  }
  const agent = defaultAgent
  // Require local inventory so this control agrees with the local Providers switch’s unset-value behavior.
  const offered =
    chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined).includes(agent) &&
    (isAgentSessionHandleProvider(agent) || installedHere?.includes(agent) === true) &&
    isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  if (!offered) {
    return undefined
  }
  return {
    agentLabel: getAgentLabel(agent),
    value: isNativeChatDefaultFor(settings, agent) ? 'chat' : 'cli',
    onChange: (value) =>
      void saveNativeChatProviderChoice({
        agent,
        on: value === 'chat',
        fallbackSettings: settings,
        updateSettings
      })
  }
}
