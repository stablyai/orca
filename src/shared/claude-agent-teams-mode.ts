import {
  tokenizeStartupCommand,
  type AgentStartupShell,
  type StartupCommandTokens
} from './tui-agent-startup-shell'

export type ClaudeAgentTeamsMode = 'off' | 'in-process' | 'native-panes-shim'

type ClaudeLaunchConfig = {
  agentCommand?: string
  agentArgs: string
}

function hasSafeTokenSpans(
  value: string,
  parsed: StartupCommandTokens
): parsed is Extract<StartupCommandTokens, { ok: true }> {
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    return false
  }
  for (let index = 0; index <= parsed.spans.length; index += 1) {
    const start = index === 0 ? 0 : parsed.spans[index - 1].end
    const end = index === parsed.spans.length ? value.length : parsed.spans[index].start
    if (!/^[ \t]*$/.test(value.slice(start, end))) {
      return false
    }
  }
  return true
}

function isClaudeExecutable(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? ''
  return /^claude(?:\.(?:exe|cmd|bat|ps1))?$/i.test(base)
}

function directClaudeExecutableIndex(
  command: string,
  shell: AgentStartupShell
): { parsed: Extract<StartupCommandTokens, { ok: true }>; index: number } | null {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!hasSafeTokenSpans(command, parsed)) {
    return null
  }
  const index = shell === 'powershell' && parsed.tokens[0] === '&' ? 1 : 0
  return isClaudeExecutable(parsed.tokens[index] ?? '') ? { parsed, index } : null
}

type Cut = { start: number; end: number }

function teammateModeCuts(
  value: string,
  parsed: Extract<StartupCommandTokens, { ok: true }>,
  startIndex: number
): Cut[] {
  const cuts: Cut[] = []
  for (let index = startIndex; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index]
    if (token === '--') {
      break
    }
    const separate = token === '--teammate-mode'
    if (!separate && !token.startsWith('--teammate-mode=')) {
      continue
    }
    const optionIndex = index
    let endIndex = optionIndex
    const valueToken = parsed.tokens[index + 1]
    if (
      separate &&
      valueToken !== undefined &&
      valueToken !== '--' &&
      !valueToken.startsWith('-')
    ) {
      endIndex += 1
      index += 1
    }
    let start = parsed.spans[optionIndex].start
    const previousEnd =
      optionIndex === startIndex
        ? (parsed.spans[startIndex - 1]?.end ?? 0)
        : parsed.spans[optionIndex - 1].end
    while (start > previousEnd && /[ \t]/.test(value[start - 1])) {
      start -= 1
    }
    cuts.push({ start, end: parsed.spans[endIndex].end })
  }
  return cuts
}

function applyCuts(value: string, cuts: readonly Cut[]): string {
  let result = value
  for (let index = cuts.length - 1; index >= 0; index -= 1) {
    result = `${result.slice(0, cuts[index].start)}${result.slice(cuts[index].end)}`
  }
  return result.trim()
}

export function isDirectClaudeCommand(
  command: string | undefined,
  shell: AgentStartupShell = 'posix'
): boolean {
  return Boolean(command?.trim() && directClaudeExecutableIndex(command.trim(), shell))
}

export function setClaudeTeammateMode(
  command: string,
  mode: 'auto' | 'in-process',
  shell: AgentStartupShell = 'posix'
): string {
  const source = command.trim()
  const direct = directClaudeExecutableIndex(source, shell)
  if (!direct) {
    return command
  }
  const stripped = applyCuts(source, teammateModeCuts(source, direct.parsed, direct.index + 1))
  const executableEnd = direct.parsed.spans[direct.index].end
  return `${stripped.slice(0, executableEnd)} --teammate-mode ${mode}${stripped.slice(executableEnd)}`
}

export function addClaudeTeammateModeAuto(
  command: string,
  shell: AgentStartupShell = 'posix'
): string {
  return setClaudeTeammateMode(command, 'auto', shell)
}

export function addClaudeTeammateModeInProcess(
  command: string,
  shell: AgentStartupShell = 'posix'
): string {
  return setClaudeTeammateMode(command, 'in-process', shell)
}

export function stripClaudeTeammateMode(args: string, shell: AgentStartupShell = 'posix'): string {
  const parsed = tokenizeStartupCommand(args, shell)
  if (!hasSafeTokenSpans(args, parsed)) {
    return args
  }
  return applyCuts(args, teammateModeCuts(args, parsed, 0))
}

export function normalizeClaudeTeammateModeLaunchConfig<T extends ClaudeLaunchConfig>(
  config: T,
  mode: 'auto' | 'in-process',
  shell: AgentStartupShell,
  fallbackCommand?: string
): T {
  const command = config.agentCommand ?? fallbackCommand
  return {
    ...config,
    ...(command ? { agentCommand: setClaudeTeammateMode(command, mode, shell) } : {}),
    agentArgs: stripClaudeTeammateMode(config.agentArgs, shell)
  }
}

export function normalizeClaudeTeammateModeArgs(
  args: readonly string[],
  defaultMode: 'auto' | 'in-process',
  forcedMode?: 'auto' | 'in-process'
): string[] {
  const retained: string[] = []
  let selectedMode: string | undefined
  let parsingOptions = true
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (parsingOptions && arg === '--') {
      parsingOptions = false
      retained.push(arg)
      continue
    }
    if (parsingOptions && arg === '--teammate-mode') {
      const value = args[index + 1]
      if (value !== undefined && value !== '--' && !value.startsWith('-')) {
        selectedMode = value
        index += 1
      }
      continue
    }
    if (parsingOptions && arg.startsWith('--teammate-mode=')) {
      selectedMode = arg.slice('--teammate-mode='.length) || undefined
      continue
    }
    retained.push(arg)
  }
  return ['--teammate-mode', forcedMode ?? selectedMode ?? defaultMode, ...retained]
}
