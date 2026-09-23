import {
  buildShellCommandFromArgv,
  commandSeparator,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

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
  // Why spans: unquoted values can't tell a quoted `|` from a pipe; divergesFromShell can.
  const tokens = parsed.tokens.map((value, index) => ({
    value,
    diverges: parsed.spans[index]?.divergesFromShell ?? true
  }))
  const isCdChain = tokens.length > 3 && tokens[0]!.value === 'cd' && tokens[2]!.value === '&&'
  // Why: `cd … &&` is the only sh syntax modelled; any other would be mistranslated.
  if (tokens.some((token, index) => token.diverges && !(isCdChain && index === 2))) {
    return null
  }
  let directory: string | null = null
  if (isCdChain) {
    directory = tokens[1]!.value
    tokens.splice(0, 3)
  }
  const assignments: { name: string; value: string }[] = []
  if (tokens[0]?.value === 'env') {
    tokens.shift()
    while (tokens[0] !== undefined && ENV_ASSIGNMENT.test(tokens[0].value)) {
      const pair = tokens.shift()!.value
      const separator = pair.indexOf('=')
      assignments.push({ name: pair.slice(0, separator), value: pair.slice(separator + 1) })
    }
  }
  if (tokens.length === 0) {
    return null
  }
  const argv = tokens.map((token) => token.value)
  const body =
    argv.length === 1 && argv[0] === 'cat'
      ? POWERSHELL_HOLDING_COMMAND
      : buildShellCommandFromArgv(argv, shell)
  return [
    // Why Stop: a failed Set-Location is non-terminating, so sh's `cd … &&` short-circuit would be lost.
    ...(directory === null
      ? []
      : [`Set-Location ${quoteStartupArg(directory, shell)} -ErrorAction Stop`]),
    ...assignments.map((each) => `$env:${each.name} = ${quoteStartupArg(each.value, shell)}`),
    body
  ].join(commandSeparator(shell))
}
