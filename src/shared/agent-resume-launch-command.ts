import type { ResumableTuiAgent } from './agent-session-resume'
import {
  isPosixStartupShell,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

function isClaudeResumeSelector(token: string): boolean {
  if (token === '--resume' || token.startsWith('--resume=')) {
    return true
  }
  if (token === '--continue' || token.startsWith('--continue=')) {
    return true
  }
  // Why: the joined -r<id> form is deliberately NOT matched — any `-r…` token
  // is ambiguous with another option's dash-leading value (`--agent -review`),
  // and no arity table can keep up with the CLI. Only exact selector shapes
  // are stripped; a persisted joined form degrades to pre-guard behavior.
  return token === '-r' || token.startsWith('-r=') || token === '-c' || token.startsWith('-c=')
}

function isExecutableToken(token: string, executable: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? ''
  return new RegExp(`^${executable}(\\.(exe|cmd|bat|ps1))?$`, 'i').test(base)
}

/** Accepts the executable token only in command position — index 0, right after
 * a wrapper's `--`, behind PowerShell's `&` call operator, or preceded solely by
 * NAME=value assignments — so an argument that merely ends in /claude (an ssh
 * key, a project dir) can never be mistaken for the executable. */
function findExecutableIndex(
  tokens: readonly string[],
  shell: AgentStartupShell,
  executable: string
): number {
  let commandPosition = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (commandPosition) {
      if (isExecutableToken(token, executable)) {
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

/** Joins the resolved base command with the agent's resume argv. Claude goes
 * through the selector guard below; other agents keep plain appending. */
export function buildAgentResumeLaunchCommand(
  agent: ResumableTuiAgent,
  baseCommand: string,
  resumeArgv: readonly string[],
  shell: AgentStartupShell
): string {
  const argv = resumeArgv.slice(1)
  if (agent === 'claude') {
    return buildClaudeResumeLaunchCommand(baseCommand, argv, shell)
  }
  if (agent === 'polytoken') {
    return buildPolytokenResumeLaunchCommand(baseCommand, argv, shell)
  }
  const resumeArgs = argv.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  return resumeArgs ? `${baseCommand} ${resumeArgs}` : baseCommand
}

/** Builds the Claude cold-restore launch command: strips any resume/continue
 * selector the user's persisted command carries and appends exactly one
 * authoritative selector, so a stale or bare selector can never compete with
 * the provider session id (#12982).
 *
 * Fails open by design: when the base command cannot be tokenized, or no
 * claude executable token can be located (wrapper commands like
 * `bash -c claude`), the base is left byte-for-byte untouched and the
 * selector is appended, which is the pre-guard behavior. Bytes outside
 * removed selector tokens are always preserved verbatim — the base is
 * spliced by source span, never re-quoted. */
export function buildClaudeResumeLaunchCommand(
  baseCommand: string,
  resumeArgs: readonly string[],
  shell: AgentStartupShell
): string {
  const quotedResume = resumeArgs.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  if (!quotedResume) {
    return baseCommand
  }
  const appended = `${baseCommand} ${quotedResume}`
  const tokenized = tokenizeStartupCommand(baseCommand, shell)
  if (!tokenized.ok) {
    return appended
  }
  const { tokens, spans } = tokenized
  const claudeIndex = findExecutableIndex(tokens, shell, 'claude')
  if (claudeIndex === -1 || !isBaseFullyModelable(baseCommand, tokens, spans, shell)) {
    return appended
  }
  const cuts: { start: number; end: number }[] = []
  let terminatorStart: number | null = null
  for (let i = claudeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      // Why: claude is the executable here, so `--` is claude's own
      // terminator; the selector must stay in option position before it.
      // Span-splice equivalent of insertBeforeTerminator in
      // tui-agent-launch-command.ts, which re-quotes and cannot be reused.
      terminatorStart = spans[i].start
      break
    }
    if (!isClaudeResumeSelector(token)) {
      continue
    }
    // Why: absorb the separator before the selector, but never cross into the
    // previous token, whose span can end with an escaped-space byte.
    let start = spans[i].start
    while (start > spans[i - 1].end && ' \t'.includes(baseCommand[start - 1])) {
      start -= 1
    }
    let end = spans[i].end
    const next = tokens[i + 1]
    if ((token === '--resume' || token === '-r') && next !== undefined && !next.startsWith('-')) {
      // A stale session locator rides along with its selector.
      end = spans[i + 1].end
      i += 1
    }
    cuts.push({ start, end })
  }
  let result = baseCommand
  if (terminatorStart !== null) {
    result = `${result.slice(0, terminatorStart)}${quotedResume} ${result.slice(terminatorStart)}`
  }
  for (let i = cuts.length - 1; i >= 0; i -= 1) {
    result = `${result.slice(0, cuts[i].start)}${result.slice(cuts[i].end)}`
  }
  return terminatorStart !== null ? result : `${result} ${quotedResume}`
}

type TokenSpan = { start: number; end: number; divergesFromShell?: boolean }

/** Why: any token the tokenizer cannot model for this shell — an operator,
 * comment, expansion, or cmd single-quoted region — means a splice could cut
 * live syntax or misread a literal. The whole base must be modelable,
 * including the executable itself; only PowerShell's leading call operator is
 * a known-safe divergent token. */
function isBaseFullyModelable(
  baseCommand: string,
  tokens: readonly string[],
  spans: readonly TokenSpan[],
  shell: AgentStartupShell
): boolean {
  for (let i = 0; i <= tokens.length; i += 1) {
    const gapStart = i === 0 ? 0 : spans[i - 1].end
    const gapEnd = i === tokens.length ? baseCommand.length : spans[i].start
    if (!/^[ \t]*$/.test(baseCommand.slice(gapStart, gapEnd))) {
      return false
    }
    if (i === tokens.length) {
      break
    }
    // Why: a bare `--%` makes PowerShell pass the rest of the line to the
    // child literally, so appended quoting would arrive as literal bytes. A
    // quoted `--%` can also stop parsing, but only before a parameter token,
    // where the base is already mangled with or without the guard.
    if (shell === 'powershell' && baseCommand.slice(spans[i].start, spans[i].end) === '--%') {
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

const POLYTOKEN_GLOBAL_OPTIONS_WITH_VALUE = new Set(['--config-dir', '--working-dir'])
const POLYTOKEN_SESSION_SUBCOMMANDS = new Set(['new', 'continue', 'attach'])

/** Builds the Polytoken cold-restore launch command. The default launch line is
 * `polytoken new`, while a resume is the sibling subcommand `polytoken continue
 * <id>`, so the subcommand span is replaced rather than appended to — appending
 * would produce `polytoken new continue <id>`, which Polytoken rejects.
 *
 * Fails safe rather than open: when the base cannot be tokenized, has no
 * polytoken executable in command position, is not fully modelable, or names
 * a non-session subcommand, the result is the bare argv form `polytoken
 * continue <id>`, which loses a custom executable path but never runs a
 * wrong subcommand. Bytes outside the replaced span are preserved verbatim. */
export function buildPolytokenResumeLaunchCommand(
  baseCommand: string,
  resumeArgs: readonly string[],
  shell: AgentStartupShell
): string {
  // Why: the leading `continue` is Polytoken's own subcommand, not user data; only the
  // session id needs shell quoting.
  const [subcommandArg, ...locatorArgs] = resumeArgs
  const quotedResume = [subcommandArg, ...locatorArgs.map((arg) => quoteStartupArg(arg, shell))]
    .filter((arg): arg is string => Boolean(arg))
    .join(' ')
  if (!quotedResume) {
    return baseCommand
  }
  const fallback = `polytoken ${quotedResume}`
  const tokenized = tokenizeStartupCommand(baseCommand, shell)
  if (!tokenized.ok) {
    return fallback
  }
  const { tokens, spans } = tokenized
  const executableIndex = findExecutableIndex(tokens, shell, 'polytoken')
  if (executableIndex === -1 || !isBaseFullyModelable(baseCommand, tokens, spans, shell)) {
    return fallback
  }
  let subcommandIndex = -1
  for (let i = executableIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      return fallback
    }
    if (POLYTOKEN_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      i += 1
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    subcommandIndex = i
    break
  }
  if (subcommandIndex === -1) {
    return `${baseCommand} ${quotedResume}`
  }
  const subcommand = tokens[subcommandIndex]
  if (!POLYTOKEN_SESSION_SUBCOMMANDS.has(subcommand)) {
    return fallback
  }
  let end = spans[subcommandIndex].end
  const next = tokens[subcommandIndex + 1]
  // Why: a persisted `continue <id>` / `attach <id>` carries a stale locator that must not
  // compete with the authoritative session id.
  if (subcommand !== 'new' && next !== undefined && !next.startsWith('-')) {
    end = spans[subcommandIndex + 1].end
  }
  return `${baseCommand.slice(0, spans[subcommandIndex].start)}${quotedResume}${baseCommand.slice(end)}`
}
