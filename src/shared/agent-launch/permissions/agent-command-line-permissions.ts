import {
  comparablePath,
  findInterpreterEntrypoint,
  isInterpreterProcessName,
  tokenizeCommandLine
} from '../../agent-status/process/agent-command-line-entrypoint'
import type { TuiAgent } from '../catalog/tui-agent'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'

const EXECUTABLE_EXT_RE = /\.(?:exe|cmd|bat|ps1)$/i

function lastOptionValue(options: readonly string[], flag: string): string | undefined {
  let last: string | undefined
  const prefix = `${flag}=`
  for (let index = 0; index < options.length; index += 1) {
    const token = options[index]
    if (token === flag && index + 1 < options.length) {
      last = options[index + 1]
      index += 1
    } else if (token.startsWith(prefix)) {
      last = token.slice(prefix.length)
    }
  }
  return last
}

function extractAgentOptionTokens(commandLine: string): string[] | null {
  const tokens = tokenizeCommandLine(commandLine)
  if (tokens.length === 0) {
    return null
  }
  const firstBase = comparablePath(tokens[0]).split('/').pop()?.replace(EXECUTABLE_EXT_RE, '') ?? ''
  let argvStart = 1
  if (isInterpreterProcessName(firstBase)) {
    const entry = findInterpreterEntrypoint(tokens, firstBase)
    if (!entry) {
      return null
    }
    argvStart = entry.argvStart
  }
  const rawArgs = tokens.slice(argvStart)
  const terminator = rawArgs.indexOf('--')
  return terminator === -1 ? rawArgs : rawArgs.slice(0, terminator)
}

const CUSTOM_BYPASS_MATCHERS: Partial<Record<TuiAgent, (options: readonly string[]) => boolean>> = {
  devin: (options) =>
    lastOptionValue(options, '--permission-mode') === 'bypass' &&
    lastOptionValue(options, '--respect-workspace-trust') === 'false',
  gemini: (options) => {
    const approvalMode = lastOptionValue(options, '--approval-mode')
    return approvalMode !== undefined
      ? approvalMode === 'yolo'
      : options.includes('--yolo') || options.includes('-y')
  },
  'qwen-code': (options) => {
    const approvalMode = lastOptionValue(options, '--approval-mode')
    return approvalMode !== undefined
      ? approvalMode === 'yolo'
      : options.includes('--yolo') || options.includes('-y')
  },
  grok: (options) => {
    const permissionMode = lastOptionValue(options, '--permission-mode')
    return permissionMode !== undefined
      ? permissionMode === 'bypassPermissions'
      : options.some(
          (token) =>
            token === '--yolo' ||
            token === '--always-approve' ||
            token === '--dangerously-skip-permissions'
        )
  },
  claude: (options) => {
    const permissionMode = lastOptionValue(options, '--permission-mode')
    return permissionMode !== undefined
      ? permissionMode === 'bypassPermissions'
      : options.includes('--dangerously-skip-permissions')
  },
  'claude-agent-teams': (options) => {
    const permissionMode = lastOptionValue(options, '--permission-mode')
    return permissionMode !== undefined
      ? permissionMode === 'bypassPermissions'
      : options.includes('--dangerously-skip-permissions')
  },
  codex: (options) =>
    options.includes('--dangerously-bypass-approvals-and-sandbox') || options.includes('--yolo'),
  kimi: (options) =>
    options.some(
      (token) =>
        token === '--auto' ||
        token === '--yolo' ||
        token === '-y' ||
        token === '--yes' ||
        token === '--auto-approve'
    )
}

/** Detect whether a live OS process command line launches `agent` in full-access bypass mode. */
export function agentCommandLineBypassesPermissions(
  agent: TuiAgent,
  commandLine: string | null | undefined
): boolean {
  const canonicalBypass = YOLO_TUI_AGENT_ARGS[agent]
  if (!commandLine || !canonicalBypass) {
    return false
  }
  const options = extractAgentOptionTokens(commandLine)
  if (!options || options.length === 0) {
    return false
  }
  const customMatcher = CUSTOM_BYPASS_MATCHERS[agent]
  if (customMatcher) {
    return customMatcher(options)
  }
  const sequence = tokenizeCommandLine(canonicalBypass)
  if (sequence.length === 0) {
    return false
  }
  if (sequence.length === 1) {
    return options.includes(sequence[0])
  }
  if (sequence.length === 2 && sequence[0].startsWith('--')) {
    return lastOptionValue(options, sequence[0]) === sequence[1]
  }
  return options.some((_, start) =>
    sequence.every((token, offset) => options[start + offset] === token)
  )
}
