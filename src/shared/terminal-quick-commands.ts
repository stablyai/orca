import type { TerminalQuickCommand, TerminalQuickCommandScope } from './types'

const MAX_QUICK_COMMANDS = 40
const MAX_QUICK_COMMAND_LABEL_LENGTH = 80
const MAX_QUICK_COMMAND_REPO_ID_LENGTH = 200
const MAX_QUICK_COMMAND_TEXT_LENGTH = 4000
const REMOVED_PRESET_IDS = new Set(['default-pwd', 'default-git-status'])

export const DEFAULT_TERMINAL_QUICK_COMMANDS: TerminalQuickCommand[] = []

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
    const hasCommand = typeof record.command === 'string'
    // Why: settings saves on every edit; preserve incomplete rows so a newly
    // added command is not deleted before the user fills in the command text.
    if (!hasLabel && !hasCommand) {
      continue
    }
    const label = hasLabel ? String(record.label).trim() : ''
    const command = hasCommand ? String(record.command).trimEnd() : ''

    const idBase = rawId || `quick-command-${normalized.length + 1}`
    let id = idBase.slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH)
    let suffix = 2
    while (seenIds.has(id)) {
      id = `${idBase.slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH - 4)}-${suffix}`
      suffix += 1
    }
    seenIds.add(id)

    normalized.push({
      id,
      label: label.slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH),
      command: command.slice(0, MAX_QUICK_COMMAND_TEXT_LENGTH),
      appendEnter: record.appendEnter !== false,
      scope: normalizeTerminalQuickCommandScope(record.scope)
    })

    if (normalized.length >= MAX_QUICK_COMMANDS) {
      break
    }
  }

  return normalized
}

export function buildTerminalQuickCommandInput(command: TerminalQuickCommand): string {
  return command.appendEnter ? `${command.command}\r` : command.command
}
