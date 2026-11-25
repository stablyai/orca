import { agentArgTerminatorIndex } from '../../agent-session/options/launch/agent-session-option-agent-args'
import { TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import { findClaudeExecutableIndex } from './agent-resume-launch-command'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** Tokens the agent parses as its own options, or null when a separator must not be added. */
function agentOptionTokens(
  agent: TuiAgent,
  launchCommand: string,
  agentArgs: string | null | undefined,
  shell: AgentStartupShell
): readonly string[] | null {
  if (agent === 'claude') {
    // Why: a wrapper that is not literally claude (Happy) can append its own flags after the
    // forwarded args, and a `--` before them would turn those flags into the prompt.
    const launch = tokenizeStartupCommand(launchCommand, shell)
    if (!launch.ok) {
      return null
    }
    const index = findClaudeExecutableIndex(launch.tokens, shell)
    return index === -1 ? null : launch.tokens.slice(index + 1)
  }
  const parsed = tokenizeStartupCommand(agentArgs?.trim() ?? '', shell)
  return parsed.ok ? parsed.tokens : []
}

/** The text to put between an argv launch command and its prompt. */
export function argvPromptSeparator(
  agent: TuiAgent,
  launchCommand: string,
  agentArgs: string | null | undefined,
  shell: AgentStartupShell
): string {
  const separator = TUI_AGENT_CONFIG[agent].argvPromptSeparator
  if (!separator) {
    return ''
  }
  // Why: once options have ended, a second `--` becomes the prompt. A wrapper's own `--`
  // (`mise exec -- grok`) does not end the agent's options.
  const tokens = agentOptionTokens(agent, launchCommand, agentArgs, shell)
  if (!tokens || agentArgTerminatorIndex(agent, tokens) < tokens.length) {
    return ''
  }
  // Why: PowerShell drops a bare `--` before a function or .ps1 shim sees $args.
  return ` ${quoteStartupArg(separator, shell)}`
}
