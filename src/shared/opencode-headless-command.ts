import { extractLeadingEnvAssignments } from './command-environment'
import { getCommandTokenPathBasename } from './command-token-scanner'
import type { AgentStartupShell } from './tui-agent-startup-shell'

const RUN_VALUE_FLAGS = new Set([
  '--log-level',
  '--completions',
  '--server',
  '--session',
  '-s',
  '--model',
  '-m',
  '--agent',
  '--format',
  '--file',
  '-f',
  '--title'
])

const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-P'])
const ENV_EMPTY_FLAGS = new Set(['-i', '--ignore-environment', '-'])

function envCommandPosition(tokens: readonly string[], offset: number): number {
  let index = offset
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') {
      index += 1
      break
    }
    if (ENV_EMPTY_FLAGS.has(token)) {
      index += 1
    } else if (ENV_VALUE_FLAGS.has(token)) {
      index += 2
    } else if (/^(?:-[uCP].+|--(?:unset|chdir)=)/.test(token)) {
      index += 1
    } else if (token.startsWith('-')) {
      // Split-string options need another parse before their executable is known.
      return tokens.length
    } else {
      break
    }
  }
  return tokens.length - extractLeadingEnvAssignments(tokens.slice(index)).rest.length
}

function openCodeCommandPosition(tokens: readonly string[], shell: AgentStartupShell): number {
  if (shell === 'powershell' && tokens[0] === '&') {
    return 1
  }
  if (shell !== 'posix') {
    return 0
  }
  let index = tokens.length - extractLeadingEnvAssignments(tokens.slice()).rest.length
  if (getCommandTokenPathBasename(tokens[index] ?? '') === 'env') {
    index = envCommandPosition(tokens, index + 1)
  }
  return index
}

export function findOpenCodeRunCommand(
  tokens: readonly string[],
  shell: AgentStartupShell = 'posix'
): { runIndex: number; messageSeparatorIndex: number | null } | null {
  const commandPosition = openCodeCommandPosition(tokens, shell)
  if (commandPosition > 0) {
    const binary = getCommandTokenPathBasename(tokens[commandPosition] ?? '')
      .toLowerCase()
      .replace(/\.(?:exe|cmd)$/, '')
    if (binary !== 'opencode' && binary !== 'opencode2') {
      return null
    }
  }
  for (let index = commandPosition + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('-')) {
      if (token !== 'run') {
        return null
      }
      for (let argumentIndex = index + 1; argumentIndex < tokens.length; argumentIndex += 1) {
        const argument = tokens[argumentIndex]
        if (argument === '--') {
          return { runIndex: index, messageSeparatorIndex: argumentIndex }
        }
        if (RUN_VALUE_FLAGS.has(argument)) {
          argumentIndex += 1
        }
      }
      return { runIndex: index, messageSeparatorIndex: null }
    }
    // Other valued global options fail closed at their first positional value.
    if (token === '--log-level') {
      index += 1
    }
  }
  return null
}

// `opencode run` takes its message as a positional argument, not through the TUI's --prompt.
export function isOpenCodeRunCommand(
  tokens: readonly string[],
  shell: AgentStartupShell = 'posix'
): boolean {
  return findOpenCodeRunCommand(tokens, shell) !== null
}
