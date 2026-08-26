import type { TuiAgent } from './tui-agent'

export function requiresOrchestrationStartupPrompt(agent: TuiAgent): boolean {
  return agent === 'zcode'
}
