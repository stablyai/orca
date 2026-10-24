/**
 * Unchosen agents route to chat when Chat UI is on; only explicit choices are saved.
 * Settings shows unchosen non-built-ins as on where their CLI or chat program is installed here.
 */

import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

export type NativeChatProviderChoices = Partial<Record<TuiAgent, boolean>>

export type NativeChatProviderSettings = Pick<GlobalSettings, 'nativeChatProviders'>

export function normalizeNativeChatProviderChoices(value: unknown): NativeChatProviderChoices {
  const choices: NativeChatProviderChoices = {}
  if (!value || typeof value !== 'object') {
    return choices
  }
  for (const [agent, on] of Object.entries(value)) {
    if (isTuiAgent(agent) && typeof on === 'boolean') {
      choices[agent] = on
    }
  }
  return choices
}

/** The switch's displayed value, independent of launch feasibility. */
export function isNativeChatProviderDisplayedOn(
  settings: Partial<NativeChatProviderSettings> | null | undefined,
  agent: TuiAgent,
  installedHere: readonly TuiAgent[] | null
): boolean {
  return (
    settings?.nativeChatProviders?.[agent] ??
    (isAgentSessionHandleProvider(agent) || installedHere?.includes(agent) === true)
  )
}

export function buildNativeChatProviderUpdate(
  settings: Partial<NativeChatProviderSettings> | null | undefined,
  agent: TuiAgent,
  on: boolean
): Pick<GlobalSettings, 'nativeChatProviders'> {
  return {
    nativeChatProviders: {
      ...normalizeNativeChatProviderChoices(settings?.nativeChatProviders),
      [agent]: on
    }
  }
}
