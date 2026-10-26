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
  // Joined -rID is ambiguous with dash-leading option values such as --agent -review; strip only exact selector shapes and append otherwise.
  return token === '-r' || token.startsWith('-r=') || token === '-c' || token.startsWith('-c=')
}

function isClaudeExecutableToken(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? ''
  return /^claude(\.(exe|cmd|bat|ps1))?$/i.test(base)
}

/** Accept claude only in command position (start, wrapper --, PowerShell &, or POSIX assignments); path-shaped arguments cannot claim execution. */
function findClaudeExecutableIndex(tokens: readonly string[], shell: AgentStartupShell): number {
  let commandPosition = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (commandPosition) {
      if (isClaudeExecutableToken(token)) {
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
  const resumeArgs = argv.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  return resumeArgs ? `${baseCommand} ${resumeArgs}` : baseCommand
}

/** Replace stale Claude resume/continue selectors with one authoritative session (#12982). Unknown tokenization/executable positions keep append-only behavior; splice source spans so other bytes retain their original quoting. */
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
  const claudeIndex = findClaudeExecutableIndex(tokens, shell)
  if (claudeIndex === -1) {
    return appended
  }
  // Splicing requires the entire base to match shell semantics, including gaps/executable; only a leading PowerShell call operator is safe divergence.
  for (let i = 0; i <= tokens.length; i += 1) {
    const gapStart = i === 0 ? 0 : spans[i - 1].end
    const gapEnd = i === tokens.length ? baseCommand.length : spans[i].start
    if (!/^[ \t]*$/.test(baseCommand.slice(gapStart, gapEnd))) {
      return appended
    }
    if (i === tokens.length) {
      break
    }
    // Bare PowerShell --% passes appended quotes literally; quoted variants before parameters already mangle the base.
    if (shell === 'powershell' && baseCommand.slice(spans[i].start, spans[i].end) === '--%') {
      return appended
    }
    if (spans[i].divergesFromShell) {
      const isCallOperator = shell === 'powershell' && i === 0 && tokens[i] === '&'
      if (!isCallOperator) {
        return appended
      }
    }
  }
  const cuts: { start: number; end: number }[] = []
  let terminatorStart: number | null = null
  for (let i = claudeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      // Keep selectors before Claude's -- terminator; preserve source spans instead of the launch builder's re-quoting.
      terminatorStart = spans[i].start
      break
    }
    if (!isClaudeResumeSelector(token)) {
      continue
    }
    // Absorb preceding whitespace without touching the prior token's possibly escaped final space.
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
