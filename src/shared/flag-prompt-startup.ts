import type { AgentStartupPlan } from './tui-agent-startup'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import type { SessionOptionValue } from './native-chat-session-options'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import { findOpenCodeRunCommand } from './opencode-headless-command'
import { openCodeStartupPromptEnv } from './opencode-startup-prompt'

export function appliedSessionOptionProps(values: Record<string, SessionOptionValue>) {
  return Object.keys(values).length > 0 ? { sessionOptions: { ...values } } : {}
}

export function buildFlagPromptStartupPlan(args: {
  agent: TuiAgent
  launchCommand: string
  quotedPrompt: string
  prompt: string
  shell: AgentStartupShell
  launchConfig: SleepingAgentLaunchConfig
  sessionOptions: Record<string, SessionOptionValue>
  agentEnv: Record<string, string> | null | undefined
}): AgentStartupPlan {
  const parsed = tokenizeStartupCommand(args.launchCommand, args.shell)
  const openCodeRun =
    (args.agent === 'opencode' || args.agent === 'opencode2') && parsed.ok
      ? findOpenCodeRunCommand(parsed.tokens, args.shell)
      : null
  // OpenCode run takes a positional message; --prompt belongs to its TUI.
  const promptSuffix = openCodeRun
    ? openCodeRun.messageSeparatorIndex !== null
      ? ` ${args.quotedPrompt}`
      : ` -- ${args.quotedPrompt}`
    : ` --prompt ${args.quotedPrompt}`
  return {
    agent: args.agent,
    launchCommand: `${args.launchCommand}${promptSuffix}`,
    expectedProcess: TUI_AGENT_CONFIG[args.agent].expectedProcess,
    launchConfig: args.launchConfig,
    ...appliedSessionOptionProps(args.sessionOptions),
    ...openCodeStartupPromptEnv(
      args.agent,
      args.launchCommand,
      args.shell,
      args.prompt,
      args.agentEnv
    )
  }
}
