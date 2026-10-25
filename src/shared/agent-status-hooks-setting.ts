import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { isTuiAgentEnabled } from './tui-agent-selection'

export type AgentStatusHooksSettings =
  | Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>>
  | null
  | undefined

// Why shared: the CLI compiles shared/ itself, so its per-launch Codex preflight needs no out/main entry.
export function isAgentStatusHooksEnabled(
  settings: Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled'>> | null | undefined
): boolean {
  return settings?.agentStatusHooksEnabled !== false
}

// Why: turning an agent off removes its hooks, so any install that reads only the global switch writes them back.
export function isAgentStatusHooksEnabledForAgent(
  settings: AgentStatusHooksSettings,
  agent: TuiAgent
): boolean {
  return (
    isAgentStatusHooksEnabled(settings) && isTuiAgentEnabled(agent, settings?.disabledTuiAgents)
  )
}
