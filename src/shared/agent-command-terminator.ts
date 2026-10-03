import type { CommandTokenSpan } from './commit-message-prompt'
import {
  isPosixStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** Matches an agent executable by basename, tolerating a Windows launcher extension. */
export function isAgentExecutableToken(token: string, executableNames: readonly string[]): boolean {
  const base = (token.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
  return executableNames.some((name) => name.toLowerCase() === base)
}

/** Accepts an agent token only in command position — index 0, right after a
 * wrapper's `--`, behind PowerShell's `&` call operator, or preceded solely by
 * NAME=value assignments — so an argument that merely ends in the agent's name
 * (an ssh key, a project dir) can never be mistaken for the executable. */
export function findAgentExecutableIndex(
  tokens: readonly string[],
  shell: AgentStartupShell,
  isAgentExecutable: (token: string) => boolean
): number {
  let commandPosition = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (commandPosition) {
      if (isAgentExecutable(token)) {
        return i
      }
      if (
        // Why: `NAME=value cmd` is sh-family syntax (fish included, 3.1+); on
        // cmd/PowerShell such a token is a bogus executable name, not a prefix.
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

/** False when any token or gap is syntax the tokenizer cannot model for this
 * shell — an operator, comment, expansion, or cmd single-quoted region — so a
 * span splice could cut live syntax. Only PowerShell's leading call operator
 * is a known-safe divergent token. */
export function isSpliceSafeStartupCommand(
  command: string,
  tokens: readonly string[],
  spans: readonly CommandTokenSpan[],
  shell: AgentStartupShell
): boolean {
  for (let i = 0; i <= tokens.length; i += 1) {
    const gapStart = i === 0 ? 0 : spans[i - 1].end
    const gapEnd = i === tokens.length ? command.length : spans[i].start
    if (!/^[ \t]*$/.test(command.slice(gapStart, gapEnd))) {
      return false
    }
    if (i === tokens.length) {
      break
    }
    // Why: a bare `--%` makes PowerShell pass the rest of the line to the
    // child literally, so appended quoting would arrive as literal bytes. A
    // quoted `--%` can also stop parsing, but only before a parameter token,
    // where the base is already mangled with or without the guard.
    if (shell === 'powershell' && command.slice(spans[i].start, spans[i].end) === '--%') {
      return false
    }
    if (spans[i].divergesFromShell) {
      const isCallOperator = shell === 'powershell' && i === 0 && tokens[i] === '&'
      if (!isCallOperator) {
        return false
      }
    }
  }
  return true
}

/** Start offset of the agent's own `--` in a startup command, or null when it
 * has none or it cannot be located safely — callers then append, the
 * pre-splice behavior. A `--` ahead of the agent belongs to a wrapper
 * (`mise exec -- codex`), never to the agent. */
export function findAgentTerminatorStart(
  command: string,
  shell: AgentStartupShell,
  executableNames: readonly string[]
): number | null {
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    return null
  }
  const { tokens, spans } = tokenized
  if (!isSpliceSafeStartupCommand(command, tokens, spans, shell)) {
    return null
  }
  const isAgent = (token: string): boolean => isAgentExecutableToken(token, executableNames)
  // Why: a wrapper with no `--` of its own (`uv run codex`) keeps the agent out of command
  // position. Fall back to the last basename match: wrapper option values that share the agent's
  // name (`ssh -i ~/.ssh/codex`) precede it. Resume stripping can't fall back at all, as a wrong
  // match there deletes a token, while here it only misplaces an insertion.
  let agentIndex = findAgentExecutableIndex(tokens, shell, isAgent)
  for (let i = tokens.length - 1; agentIndex === -1 && i >= 0; i -= 1) {
    if (isAgent(tokens[i])) {
      agentIndex = i
    }
  }
  if (agentIndex === -1) {
    return null
  }
  const terminator = tokens.indexOf('--', agentIndex + 1)
  return terminator === -1 ? null : spans[terminator].start
}
