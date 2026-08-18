import { isPosixStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'

export function isClaudeExecutableToken(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? ''
  return /^claude(\.(exe|cmd|bat|ps1))?$/i.test(base)
}

/** Accepts a claude token only in command position — index 0, right after a
 * wrapper's `--`, behind PowerShell's `&` call operator, or preceded solely by
 * NAME=value assignments — so an argument that merely ends in /claude (an ssh
 * key, a project dir) can never be mistaken for the executable. */
export function findClaudeExecutableIndex(
  tokens: readonly string[],
  shell: AgentStartupShell
): number {
  let commandPosition = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (commandPosition) {
      if (isClaudeExecutableToken(token)) {
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
