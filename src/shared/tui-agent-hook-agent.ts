import type { AgentHookSource } from './agent-hook-relay'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

// Why: these launches run Claude Code's hooks (Agent Teams wraps `claude`; OpenClaude's managed
// script posts to the Claude route). Every other launch's hooks name the launch itself.
const HOOK_AGENT_BY_LAUNCH: Partial<Record<TuiAgent, AgentHookSource>> = {
  'claude-agent-teams': 'claude',
  openclaude: 'claude'
}

/** The agent a launched agent's hook events name. */
export function getTuiAgentHookAgent(launchAgent: string): string {
  return (isTuiAgent(launchAgent) && HOOK_AGENT_BY_LAUNCH[launchAgent]) || launchAgent
}
