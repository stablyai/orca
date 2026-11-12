import { recognizeAgentLaunchCommand } from '../../agent-launch/startup/agent-command-line-intent'
import { tokenizeCommandLine } from '../process/agent-command-line-entrypoint'
import { optionName } from '../process/print-mode-headless-command'
import type { TerminalAgent } from '../identity/terminal-agent'

// One-shot informational flags: the process prints and exits, so no composer ever follows.
const INFORMATIONAL_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V'])

// Claude subcommands that run a server, an installer, an auth flow or a one-shot report instead
// of a session, so no composer ever follows (list read from `claude --help`, 2.1.322). `agents`,
// `attach` and `import` are left out: they open an interactive view or session in the terminal.
const NON_SESSION_SUBCOMMANDS: Partial<Record<TerminalAgent, ReadonlySet<string>>> = {
  claude: new Set([
    'auth',
    'auto-mode',
    'doctor',
    'gateway',
    'install',
    'kill',
    'logs',
    'mcp',
    'plugin',
    'plugins',
    'purge',
    'respawn',
    'rm',
    'setup-token',
    'stop',
    'ultrareview',
    'update',
    'upgrade'
  ])
}

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

/** Whether the first argument that is not an option names a non-session subcommand
 *  (`claude mcp serve`, `claude --debug doctor`). Option values are not modelled: after a
 *  value-taking option (`claude --model opus mcp serve`) the value is read as the first argument
 *  and the title still counts as a session. */
function hasNonSessionSubcommand(tokens: readonly string[], agent: TerminalAgent): boolean {
  const subcommands = NON_SESSION_SUBCOMMANDS[agent]
  if (!subcommands) {
    return false
  }
  // `--` ends option parsing; what follows is a prompt (`claude -- mcp`).
  const first = tokens.slice(1).find((token) => token === '--' || !token.startsWith('-'))
  return first !== undefined && subcommands.has(first)
}

/**
 * Whether a shell's command-shaped title (`claude`, `claude --resume`) positively names an
 * interactive TUI launch of `agent`, as opposed to a pipeline, a redirect, a headless one-shot
 * (`claude -p …`, `--output-format json`), an informational run (`claude --help`) or a non-session
 * subcommand (`claude mcp serve`), none of which ever draws the agent's composer. Why positive: a title is a retained heuristic, so only a title
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
  const tokens = tokenizeCommandLine(title)
  return !hasInformationalFlag(tokens) && !hasNonSessionSubcommand(tokens, agent)
}
