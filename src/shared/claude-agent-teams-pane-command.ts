import {
  buildShellCommandFromArgv,
  commandSeparator,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SH_OPERATOR = /[;&|<>]/

/**
 * Claude Code holds a placeholder pane open with `cat` until `respawn-pane`
 * replaces it. PowerShell's `cat` is Get-Content, which blocks on a prompt for
 * its mandatory Path instead — alive, but showing the user a stray prompt that
 * would read a file if anything typed into it. Wait-Event blocks silently.
 */
const POWERSHELL_HOLDING_COMMAND = 'Wait-Event'

/**
 * True when Orca can express a teammate pane command in this shell. `cmd` is
 * excluded because its `set "NAME=value"` form cannot carry a `"`, `%` or `!`
 * safely, and a mis-quoted teammate launch is worse than the in-process fallback.
 */
export function supportsClaudeAgentTeamsPaneCommand(shell: AgentStartupShell): boolean {
  return shell !== 'cmd'
}

/** A pane command as the pane's own shell should read it; undefined when there is none. */
export function claudeAgentTeamsPaneCommand(
  command: string,
  shell: AgentStartupShell
): string | undefined {
  if (!command) {
    return undefined
  }
  return retargetClaudeAgentTeamsPaneCommand(command, shell) ?? command
}

/**
 * Re-spells a teammate pane command for the shell Orca types it into.
 *
 * Claude Code writes it for `/bin/sh` — real tmux runs pane commands through
 * `sh -c`, so `cd '<dir>' && env NAME=value <argv…>` is valid there. Orca hands
 * the text to the pane's own shell, where on Windows `env` is not a command and
 * `&&` does not chain a directory change.
 *
 * Returns null when the shell already speaks sh or the command is not that
 * shape, so callers keep the original text rather than guessing.
 */
export function retargetClaudeAgentTeamsPaneCommand(
  command: string,
  shell: AgentStartupShell
): string | null {
  if (shell !== 'powershell') {
    return null
  }
  const parsed = tokenizeStartupCommand(command, 'posix')
  if (!parsed.ok) {
    return null
  }
  const tokens = [...parsed.tokens]
  let directory: string | null = null
  if (tokens.length > 3 && tokens[0] === 'cd' && tokens[2] === '&&') {
    directory = tokens[1]!
    tokens.splice(0, 3)
  }
  const assignments: { name: string; value: string }[] = []
  if (tokens[0] === 'env') {
    tokens.shift()
    while (tokens[0] !== undefined && ENV_ASSIGNMENT.test(tokens[0])) {
      const pair = tokens.shift()!
      const separator = pair.indexOf('=')
      assignments.push({ name: pair.slice(0, separator), value: pair.slice(separator + 1) })
    }
  }
  // Why: a surviving operator means sh would run something this rewrite does not
  // model, and PowerShell would read it differently again.
  if (tokens.length === 0 || tokens.some((token) => SH_OPERATOR.test(token))) {
    return null
  }
  const body =
    tokens.length === 1 && tokens[0] === 'cat'
      ? POWERSHELL_HOLDING_COMMAND
      : buildShellCommandFromArgv(tokens, shell)
  return [
    ...(directory === null ? [] : [`Set-Location ${quoteStartupArg(directory, shell)}`]),
    ...assignments.map((each) => `$env:${each.name} = ${quoteStartupArg(each.value, shell)}`),
    body
  ].join(commandSeparator(shell))
}
