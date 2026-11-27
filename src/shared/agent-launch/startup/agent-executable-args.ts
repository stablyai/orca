// Launch-only args spliced in right after an agent's executable in a startup command, so a prompt,
// a `--` or a resume selector after it keeps its meaning.
import {
  isPosixStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** An executable token for `names` (a path, or with a Windows launcher extension). */
export function isAgentExecutableToken(token: string, names: readonly string[]): boolean {
  const base = (token.split(/[\\/]/).pop() ?? '').toLowerCase()
  const stem = base.replace(/\.(exe|cmd|bat|ps1)$/, '')
  return names.includes(stem)
}

/** Accept the executable only in command position (start, wrapper --, PowerShell &, or POSIX
 *  assignments); path-shaped arguments cannot claim execution. */
export function findAgentExecutableIndex(
  tokens: readonly string[],
  shell: AgentStartupShell,
  isExecutable: (token: string) => boolean
): number {
  let commandPosition = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (commandPosition) {
      if (isExecutable(token)) {
        return i
      }
      if (
        // NAME=value prefixes are POSIX/fish3.1+ syntax; Windows shells treat them as executable names.
        (isPosixStartupShell(shell) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ||
        (shell === 'powershell' && token === '&' && i === 0)
      ) {
        continue
      }
      commandPosition = false
    }
    if (token === '--') {
      commandPosition = true
    }
  }
  return -1
}

/**
 * `command` with `quotedArgs` (already quoted for `shell`, led by a space) right after the agent's
 * executable, or after the `subcommand` that must follow it (`orca claude-teams`); null when that
 * can't be done safely: a wrapper or prefix the args might not reach, or a span whose shell parse
 * differs from Orca's.
 */
export function withArgsAfterAgentExecutable(
  command: string,
  shell: AgentStartupShell,
  findIndex: (tokens: readonly string[], shell: AgentStartupShell) => number,
  quotedArgs: string,
  subcommand?: string
): string | null {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return null
  }
  const index = findIndex(parsed.tokens, shell)
  if (
    index < 0 ||
    (subcommand !== undefined && parsed.tokens[index + 1] !== subcommand) ||
    parsed.tokens
      .slice(0, index)
      .some(
        (token, at) =>
          !(
            (shell === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ||
            (shell === 'powershell' && at === 0 && token === '&')
          )
      )
  ) {
    return null
  }
  for (let i = 0; i <= parsed.tokens.length; i++) {
    const start = i === 0 ? 0 : parsed.spans[i - 1].end
    const end = i === parsed.tokens.length ? command.length : parsed.spans[i].start
    if (!/^[ \t]*$/.test(command.slice(start, end))) {
      return null
    }
    if (
      i < parsed.tokens.length &&
      parsed.spans[i].divergesFromShell &&
      !(shell === 'powershell' && i === 0 && parsed.tokens[i] === '&')
    ) {
      return null
    }
  }
  const end = parsed.spans[subcommand === undefined ? index : index + 1].end
  return `${command.slice(0, end)}${quotedArgs}${command.slice(end)}`
}
