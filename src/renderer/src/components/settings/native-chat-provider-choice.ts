import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentDefaultSurface } from '../../../../shared/native-chat/native-chat-appearance-settings'
import {
  buildNativeChatProviderUpdate,
  normalizeAgentDefaultSurface,
  normalizeNativeChatProviderChoices
} from '../../../../shared/native-chat/native-chat-providers'
import { nativeChatPreferenceFor } from '../../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { chatProviderAgents } from '@/lib/chat-provider-agents'
import { useAppStore } from '../../store'
import { createAgentSettingsUpdateQueue } from './agent-availability-settings'

// Serialize the default and shared-map writes so rapid flips cannot overwrite each other.
const enqueueProviderUpdate = createAgentSettingsUpdateQueue()

type SettingsWriter = {
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** Agents set for themselves to the other surface, among those whose row offers Chat | CLI. */
export function agentsKeepingOwnSurface(
  settings: GlobalSettings,
  surface: AgentDefaultSurface
): TuiAgent[] {
  const choices = normalizeNativeChatProviderChoices(settings.nativeChatProviders)
  return chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined).filter(
    (agent) =>
      isTuiAgentEnabled(agent, settings.disabledTuiAgents) &&
      typeof choices[agent] === 'boolean' &&
      choices[agent] !== (surface === 'chat')
  )
}

export function saveAgentDefaultSurface({
  surface,
  ...writer
}: SettingsWriter & { surface: AgentDefaultSurface }): Promise<void> {
  return enqueueProviderUpdate({
    getSettings: () => useAppStore.getState().settings,
    ...writer,
    buildUpdate: () => ({ agentDefaultSurface: surface })
  })
}

/** Drops these agents' own choices so they follow the default, unless the default moved since. */
export function followAgentDefaultSurface({
  agents,
  surface,
  ...writer
}: SettingsWriter & { agents: readonly TuiAgent[]; surface: AgentDefaultSurface }): Promise<void> {
  return enqueueProviderUpdate({
    getSettings: () => useAppStore.getState().settings,
    ...writer,
    buildUpdate: (latest) => {
      if (normalizeAgentDefaultSurface(latest.agentDefaultSurface) !== surface) {
        return {}
      }
      const choices = normalizeNativeChatProviderChoices(latest.nativeChatProviders)
      for (const agent of agents) {
        delete choices[agent]
      }
      return { nativeChatProviders: choices }
    }
  })
}

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
    chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined).includes(agent) &&
    isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  if (!offered) {
    return undefined
  }
  return {
    value: nativeChatPreferenceFor(settings, agent) ? 'chat' : 'cli',
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
