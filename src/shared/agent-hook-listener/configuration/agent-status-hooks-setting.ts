import type { GlobalSettings } from '../../settings/global-settings-types'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { isTuiAgentEnabled } from '../../agent-launch/catalog/tui-agent-selection'
import { isAgentHookConsentGranted } from './agent-hook-consent'

export type AgentStatusHooksSettings =
  | Partial<
      Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents' | 'agentHookConsent'>
    >
  | null
  | undefined

// Why shared: the CLI compiles shared/ itself, so its per-launch Codex preflight needs no out/main entry.
export function isAgentStatusHooksEnabled(
  settings: Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled'>> | null | undefined
): boolean {
  return settings?.agentStatusHooksEnabled !== false
}

// Why: turning an agent off removes its hooks, so any install that reads only the global switch writes them back;
// hooks edit the user's agent config, so an agent is managed only after the user agrees.
export function isAgentStatusHooksEnabledForAgent(
  settings: AgentStatusHooksSettings,
  agent: TuiAgent
): boolean {
  return (
    isAgentStatusHooksEnabled(settings) &&
    isTuiAgentEnabled(agent, settings?.disabledTuiAgents) &&
    isAgentHookConsentGranted(settings, agent)
  )
}
