import {
  getAgentLaunchExecutableName,
  recognizeAgentLaunchCommand
} from '../../agent-launch/startup/agent-command-line-intent'
import { tokenizeCommandLine } from '../process/agent-command-line-entrypoint'
import { classifyClaudeArgv } from './claude-cli-argv-classification'
import type { TerminalAgent } from '../identity/terminal-agent'

/** An unquoted pipe, redirect, separator or background operator: the title names a pipeline or a
 *  one-shot, not a TUI owning the terminal. Quoted operators are prompt text (`claude "a | b"`). */
function hasUnquotedShellOperator(commandLine: string): boolean {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const char of commandLine) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '|' || char === '<' || char === '>' || char === ';' || char === '&') {
      return true
    }
  }
  return false
}

/**
 * Whether a shell's command-shaped title (`claude`, `claude --resume`) positively names an
 * interactive TUI launch of `agent`, as opposed to a pipeline, a redirect, a headless one-shot
 * (`claude -p …`), an informational run (`claude --help`), a background launch (`claude --bg`) or
 * a non-session subcommand (`claude mcp serve`), none of which draws the agent's composer here.
 * Why positive: a title is a retained heuristic, so only a title that reads as the TUI itself may
 * make the tui-idle wait hold for that TUI's own paint (STA-14925). Anything else, including an
 * argv the agent's grammar table does not recognize and an agent with no table, is not a known
 * interactive launch and the pane keeps the rule it had before.
 */
export function titleCommandLaunchesInteractiveTui(title: string, agent: TerminalAgent): boolean {
  // Only Claude's paint is its own composer marker, so only Claude's grammar is modelled.
  if (agent !== 'claude' || hasUnquotedShellOperator(title)) {
    return false
  }
  if (recognizeAgentLaunchCommand(title)?.agent !== agent) {
    return false
  }
  // Why the first token must be the executable: an interpreter or env prefix moves the argv, and a
  // misread argv must not hold the pane. `Claude Code`, the agent's own title, reads the same way.
  if (getAgentLaunchExecutableName(title) !== 'claude') {
    return false
  }
  return classifyClaudeArgv(tokenizeCommandLine(title).slice(1)) === 'interactive-session'
}
