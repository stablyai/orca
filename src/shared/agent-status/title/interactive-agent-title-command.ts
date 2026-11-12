import { recognizeAgentLaunchCommand } from '../../agent-launch/startup/agent-command-line-intent'
import { tokenizeCommandLine } from '../process/agent-command-line-entrypoint'
import { optionName } from '../process/print-mode-headless-command'
import type { TerminalAgent } from '../identity/terminal-agent'

// One-shot informational flags: the process prints and exits, so no composer ever follows.
const INFORMATIONAL_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V'])

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

function hasInformationalFlag(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    // `--` ends option parsing; a prompt that reads like `--help` is still a prompt.
    if (tokens[index] === '--') {
      return false
    }
    if (INFORMATIONAL_FLAGS.has(optionName(tokens[index]))) {
      return true
    }
  }
  return false
}

/**
 * Whether a shell's command-shaped title (`claude`, `claude --resume`) positively names an
 * interactive TUI launch of `agent`, as opposed to a pipeline, a redirect, a headless one-shot
 * (`claude -p …`, `--output-format json`) or an informational run (`claude --help`), none of which
 * ever draws the agent's composer. Why positive: a title is a retained heuristic, so only a title
 * that reads as the TUI itself may make the tui-idle wait hold for that TUI's own paint
 * (STA-14925). A title that is not a command line at all does not qualify either.
 */
export function titleCommandLaunchesInteractiveTui(title: string, agent: TerminalAgent): boolean {
  if (hasUnquotedShellOperator(title)) {
    return false
  }
  // TUI-only recognition: print-mode and other headless one-shots already fall out here.
  if (recognizeAgentLaunchCommand(title)?.agent !== agent) {
    return false
  }
  return !hasInformationalFlag(tokenizeCommandLine(title))
}
