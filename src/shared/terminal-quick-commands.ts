import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import type {
  TerminalAgentQuickCommand,
  TerminalCommandQuickCommand,
  TerminalQuickCommand,
  TerminalQuickCommandAction,
  TerminalQuickCommandScope
} from './types'

export const MAX_QUICK_COMMANDS = 40
export const MAX_QUICK_COMMAND_ID_LENGTH = 80
export const MAX_QUICK_COMMAND_LABEL_LENGTH = 80
export const MAX_QUICK_COMMAND_REPO_ID_LENGTH = 200
export const MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH = 4000
// Why: agent prompt quick commands still launch through startup commands for
// argv/flag agents, so this must stay within Orca's Windows shell safety cap.
export const MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH = 6000
const REMOVED_PRESET_IDS = new Set(['default-pwd', 'default-git-status'])

const DEFAULT_TERMINAL_QUICK_COMMANDS: TerminalQuickCommand[] = []

export type TerminalQuickCommandMutation =
  | { type: 'upsert'; command: TerminalQuickCommand }
  | { type: 'delete'; id: string }

export function getDefaultTerminalQuickCommands(): TerminalQuickCommand[] {
  return DEFAULT_TERMINAL_QUICK_COMMANDS.map((command) => ({ ...command }))
}

function normalizeTerminalQuickCommandScope(input: unknown): TerminalQuickCommandScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { type: 'global' }
  }
  const record = input as Record<string, unknown>
  if (record.type !== 'repo') {
    return { type: 'global' }
  }
  const repoId = typeof record.repoId === 'string' ? record.repoId.trim() : ''
  if (!repoId) {
    return { type: 'global' }
  }
  return { type: 'repo', repoId: repoId.slice(0, MAX_QUICK_COMMAND_REPO_ID_LENGTH) }
}

export function getTerminalQuickCommandScope(
  command: TerminalQuickCommand
): TerminalQuickCommandScope {
  return normalizeTerminalQuickCommandScope(command.scope)
}

export function terminalQuickCommandMatchesRepo(
  command: TerminalQuickCommand,
  repoId: string | null
): boolean {
  const scope = getTerminalQuickCommandScope(command)
  return scope.type === 'global' || (repoId !== null && scope.repoId === repoId)
}

export function getTerminalQuickCommandAction(
  command: TerminalQuickCommand
): TerminalQuickCommandAction {
  return command.action === 'agent-prompt' ? 'agent-prompt' : 'terminal-command'
}

export function isTerminalAgentQuickCommand(
  command: TerminalQuickCommand
): command is TerminalAgentQuickCommand {
  return getTerminalQuickCommandAction(command) === 'agent-prompt'
}

export function supportsTerminalAgentQuickCommand(
  agent: unknown
): agent is TerminalAgentQuickCommand['agent'] {
  return isTuiAgent(agent) && TUI_AGENT_CONFIG[agent].promptInjectionMode !== 'stdin-after-start'
}

export function getTerminalQuickCommandBody(command: TerminalQuickCommand): string {
  return isTerminalAgentQuickCommand(command) ? command.prompt : command.command
}

export function isTerminalQuickCommandComplete(command: TerminalQuickCommand): boolean {
  return command.label.trim().length > 0 && getTerminalQuickCommandBody(command).trim().length > 0
}

export function normalizeTerminalQuickCommands(input: unknown): TerminalQuickCommand[] {
  if (!Array.isArray(input)) {
    return getDefaultTerminalQuickCommands()
  }

  const normalized: TerminalQuickCommand[] = []
  const seenIds = new Set<string>()

  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const record = item as Record<string, unknown>
    const rawId = typeof record.id === 'string' ? record.id.trim() : ''
    if (REMOVED_PRESET_IDS.has(rawId)) {
      continue
    }
    const hasLabel = typeof record.label === 'string'
    const action: TerminalQuickCommandAction =
      record.action === 'agent-prompt' ? 'agent-prompt' : 'terminal-command'
    const hasCommand = typeof record.command === 'string'
    const hasPrompt = typeof record.prompt === 'string'
    // Why: settings saves on every edit; preserve incomplete rows so a newly
    // added command is not deleted before the user fills in the command text.
    if (!hasLabel && !hasCommand && !hasPrompt) {
      continue
    }
    const agent = supportsTerminalAgentQuickCommand(record.agent) ? record.agent : null
    if (action === 'agent-prompt' && agent === null) {
      continue
    }
    const label = hasLabel ? String(record.label).trim() : ''

    const idBase = rawId || `quick-command-${normalized.length + 1}`
    let id = idBase.slice(0, MAX_QUICK_COMMAND_ID_LENGTH)
    let suffix = 2
    while (seenIds.has(id)) {
      id = `${idBase.slice(0, MAX_QUICK_COMMAND_ID_LENGTH - 4)}-${suffix}`
      suffix += 1
    }
    seenIds.add(id)

    const base = {
      id,
      label: label.slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH),
      scope: normalizeTerminalQuickCommandScope(record.scope)
    }

    if (action === 'agent-prompt') {
      if (agent === null) {
        continue
      }
      const agentId = agent
      normalized.push({
        ...base,
        action: 'agent-prompt',
        agent: agentId,
        prompt: (hasPrompt ? String(record.prompt).trimEnd() : '').slice(
          0,
          MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
        )
      })
    } else {
      const command = hasCommand ? String(record.command).trimEnd() : ''
      normalized.push({
        ...base,
        action: 'terminal-command',
        command: command.slice(0, MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH),
        appendEnter: record.appendEnter !== false
      })
    }

    if (normalized.length >= MAX_QUICK_COMMANDS) {
      break
    }
  }

  return normalized
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

function isNormalizedTerminalQuickCommandScope(
  value: unknown,
  expected: TerminalQuickCommandScope
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const scope = value as Record<string, unknown>
  if (expected.type === 'global') {
    return hasExactKeys(scope, ['type']) && scope.type === 'global'
  }
  return (
    hasExactKeys(scope, ['type', 'repoId']) &&
    scope.type === 'repo' &&
    scope.repoId === expected.repoId
  )
}

function isNormalizedTerminalQuickCommand(value: unknown, expected: TerminalQuickCommand): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const command = value as Record<string, unknown>
  if (
    command.id !== expected.id ||
    command.label !== expected.label ||
    !isNormalizedTerminalQuickCommandScope(command.scope, expected.scope ?? { type: 'global' })
  ) {
    return false
  }
  if (isTerminalAgentQuickCommand(expected)) {
    return (
      hasExactKeys(command, ['id', 'label', 'action', 'agent', 'prompt', 'scope']) &&
      command.action === 'agent-prompt' &&
      command.agent === expected.agent &&
      command.prompt === expected.prompt
    )
  }
  return (
    hasExactKeys(command, ['id', 'label', 'action', 'command', 'appendEnter', 'scope']) &&
    command.action === 'terminal-command' &&
    command.command === expected.command &&
    command.appendEnter === expected.appendEnter
  )
}

// Why: a full-list client must reject any "authoritative" payload that would
// change under normalization, or its next mutation could persist silent loss.
export function parseNormalizedTerminalQuickCommands(
  input: unknown
): TerminalQuickCommand[] | null {
  if (!Array.isArray(input) || input.length > MAX_QUICK_COMMANDS) {
    return null
  }
  const normalized = normalizeTerminalQuickCommands(input)
  if (
    normalized.length !== input.length ||
    normalized.some((command, index) => !isNormalizedTerminalQuickCommand(input[index], command))
  ) {
    return null
  }
  return normalized
}

// Why: paired clients can edit settings concurrently. Applying one command at
// the host boundary preserves unrelated commands added by another client.
export function applyTerminalQuickCommandMutation(
  commands: readonly TerminalQuickCommand[],
  mutation: TerminalQuickCommandMutation
): TerminalQuickCommand[] {
  if (mutation.type === 'delete') {
    return commands.filter((command) => command.id !== mutation.id)
  }
  const existingIndex = commands.findIndex((command) => command.id === mutation.command.id)
  if (existingIndex === -1) {
    return [...commands, mutation.command]
  }
  return commands.map((command, index) => (index === existingIndex ? mutation.command : command))
}

export function buildTerminalQuickCommandInput(command: TerminalCommandQuickCommand): string {
  return command.appendEnter ? `${command.command}\r` : command.command
}

const LINE_BREAK_RE = /\r\n|\r|\n/

// Why: quick-command lines are independent shell commands; one shell command
// list prevents foreground programs from reading later lines as stdin.
export function flattenTerminalQuickCommand(
  command: TerminalCommandQuickCommand
): TerminalCommandQuickCommand {
  if (!LINE_BREAK_RE.test(command.command)) {
    return command
  }
  return {
    ...command,
    command: command.command
      .split(LINE_BREAK_RE)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('; ')
  }
}
