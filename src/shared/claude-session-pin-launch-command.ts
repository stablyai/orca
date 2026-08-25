import { findClaudeExecutableIndex } from './claude-launch-executable-token'
import {
  isFullyModelableStartupCommand,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/** Every flag that makes the CLI choose its own session identity. If the user's
 * command already carries one, Orca must not add a competing `--session-id`. */
function isClaudeSessionSelector(token: string): boolean {
  return (
    token === '--session-id' ||
    token.startsWith('--session-id=') ||
    token === '--resume' ||
    token.startsWith('--resume=') ||
    token === '--continue' ||
    token.startsWith('--continue=') ||
    token === '--fork-session' ||
    token === '-r' ||
    token.startsWith('-r=') ||
    token === '-c' ||
    token.startsWith('-c=')
  )
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Splices `--session-id <uuid>` into a Claude launch so the host keeps a
 * process-independent handle on the session it is about to start.
 *
 * Why this exists: Claude Code >= 2.1.206 hosts TUI sessions as workers under a
 * shared daemon, and the daemon forwards only its own allowlisted env — so a
 * pane's `ORCA_PANE_KEY` never reaches the worker that runs the hooks. The
 * session id is the one identity that does survive into the hook payload, so
 * pinning it at spawn is what lets the host recover the true pane later.
 *
 * Fails CLOSED — returns null rather than a best-effort command. Pinning is an
 * attribution improvement, never a launch requirement, so any doubt about the
 * command's shape (untokenizable, wrapper-launched, compound, redirected,
 * already session-selecting) leaves the user's command byte-for-byte alone.
 * Bytes outside the insertion point are always preserved verbatim; the command
 * is spliced by source span and never re-quoted.
 */
export function pinClaudeLaunchSessionId(
  baseCommand: string,
  sessionId: string,
  shell: AgentStartupShell
): string | null {
  if (!SESSION_ID_RE.test(sessionId)) {
    return null
  }
  const tokenized = tokenizeStartupCommand(baseCommand, shell)
  if (!tokenized.ok) {
    return null
  }
  const { tokens, spans } = tokenized
  const claudeIndex = findClaudeExecutableIndex(tokens, shell)
  if (claudeIndex === -1) {
    return null
  }
  // Why: modelability is what rules out compounds, pipelines and redirects —
  // their operators tokenize as shell-divergent, so `claude && deploy` can
  // never take a pin that would land on the wrong word.
  if (!isFullyModelableStartupCommand(baseCommand, tokens, spans, shell)) {
    return null
  }
  for (let i = claudeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    // Why: `--` is claude's own terminator, so anything after it is the child's
    // argv, not a claude flag — a selector there is not ours to compete with.
    if (token === '--') {
      break
    }
    if (isClaudeSessionSelector(token)) {
      return null
    }
  }
  // Why immediately after the executable rather than appended: `--session-id` is
  // a ROOT option, and `claude <subcommand>` (`mcp list`, `doctor`, `update`)
  // rejects unknown options, so a trailing pin makes those launches fail
  // outright. Root position is also before claude's own `--` terminator, which
  // a trailing pin would fall past.
  const insertAt = spans[claudeIndex].end
  return `${baseCommand.slice(0, insertAt)} --session-id ${sessionId}${baseCommand.slice(insertAt)}`
}
