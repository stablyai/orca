import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup'
import type { TuiAgent } from '../../../../shared/types'

export const TERMINAL_AGENT_QUICK_COMMAND_PRESET_PROMPT = 'your prompt here'

export type TerminalAgentQuickCommandPreset = {
  agent: TuiAgent
  label: string
  command: string
  startsWithPrompt: boolean
}

export function buildTerminalAgentQuickCommandPreset(args: {
  agent: TuiAgent
  label: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
}): TerminalAgentQuickCommandPreset | null {
  const plan = buildAgentStartupPlan({
    agent: args.agent,
    prompt: TERMINAL_AGENT_QUICK_COMMAND_PRESET_PROMPT,
    cmdOverrides: args.cmdOverrides,
    platform: args.platform,
    ...(args.shell ? { shell: args.shell } : {})
  })
  if (!plan) {
    return null
  }

  // Why: quick commands only store one terminal input string. Agents that need
  // a post-start paste can still be launched, but the prompt cannot be encoded
  // in the saved quick-command text without runtime readiness handling.
  const startsWithPrompt = plan.followupPrompt === null

  return {
    agent: args.agent,
    label: args.label,
    command: plan.launchCommand,
    startsWithPrompt
  }
}
