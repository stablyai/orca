// Persist the default surface independently from per-agent overrides.

import type { GlobalSettings } from '../global-settings-types'
import type { TuiAgent } from '../tui-agent'
import { isStructuredAgentId } from '../agent-session-provider-handle-encoding'
import type { AgentDefaultSurface } from './native-chat-appearance-settings'

export type NativeChatProviderChoices = Partial<Record<string, boolean>>

export type NativeChatProviderSettings = Pick<
  GlobalSettings,
  'nativeChatProviders' | 'agentDefaultSurface'
>

export function normalizeAgentDefaultSurface(value: unknown): AgentDefaultSurface {
  return value === 'chat' ? 'chat' : 'terminal'
}

export function normalizeNativeChatProviderChoices(value: unknown): NativeChatProviderChoices {
  const choices: NativeChatProviderChoices = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return choices
  }
  for (const [agent, on] of Object.entries(value)) {
    if (isStructuredAgentId(agent) && typeof on === 'boolean') {
      choices[agent] = on
    }
  }
  return choices
}

export function buildNativeChatProviderUpdate(
  settings: Partial<NativeChatProviderSettings> | null | undefined,
  agent: TuiAgent,
  on: boolean
): Pick<GlobalSettings, 'nativeChatProviders'> {
  const choices = normalizeNativeChatProviderChoices(settings?.nativeChatProviders)
  if (on === (settings?.agentDefaultSurface === 'chat')) {
    delete choices[agent]
  } else {
    choices[agent] = on
  }
  return { nativeChatProviders: choices }
}

/** Carry effective legacy intent without pinning an agent inventory to the old switch. */
export function carriedChatUiLaunchSettings(
  savedChoices: unknown,
  chatUiOn: boolean
): NativeChatProviderSettings {
  return {
    agentDefaultSurface: chatUiOn ? 'chat' : 'terminal',
    nativeChatProviders: chatUiOn
      ? Object.fromEntries(
          Object.entries(normalizeNativeChatProviderChoices(savedChoices)).filter(([, on]) => !on)
        )
      : {}
  }
}
