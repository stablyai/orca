export const TERMINAL_QUICK_COMMAND_PLACEHOLDER_NAMES = [
  'file',
  'relativeFile',
  'fileBasename',
  'fileDirname',
  'workspaceFolder'
] as const

export type TerminalQuickCommandPlaceholderName =
  (typeof TERMINAL_QUICK_COMMAND_PLACEHOLDER_NAMES)[number]

export type TerminalQuickCommandPlaceholderContext = {
  filePath: string | null
  relativePath: string | null
  workspaceFolder: string | null
}

export type TerminalQuickCommandPlaceholderResult =
  | { status: 'ok'; command: string }
  | { status: 'missing-file' }
  | { status: 'missing-workspace' }

const PLACEHOLDER_NAME_SET = new Set<string>(TERMINAL_QUICK_COMMAND_PLACEHOLDER_NAMES)

const PLACEHOLDER_PATTERN = /\$\{(file|relativeFile|fileBasename|fileDirname|workspaceFolder)\}/g

export function terminalQuickCommandUsesPlaceholders(command: string): boolean {
  return /\$\{(?:file|relativeFile|fileBasename|fileDirname|workspaceFolder)\}/.test(command)
}

export function substituteTerminalQuickCommandPlaceholders(
  command: string,
  context: TerminalQuickCommandPlaceholderContext
): TerminalQuickCommandPlaceholderResult {
  let missingFile = false
  let missingWorkspace = false
  const next = command.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    if (!isPlaceholderName(name)) {
      return match
    }
    if (name !== 'workspaceFolder') {
      const value = filePlaceholderValue(name, context)
      if (value === null) {
        missingFile = true
        return match
      }
      return value
    }
    if (!context.workspaceFolder) {
      missingWorkspace = true
      return match
    }
    return context.workspaceFolder
  })
  if (missingFile) {
    return { status: 'missing-file' }
  }
  if (missingWorkspace) {
    return { status: 'missing-workspace' }
  }
  return { status: 'ok', command: next }
}

export function fileBasename(filePath: string): string {
  const separator = lastPathSeparatorIndex(filePath)
  return separator === -1 ? filePath : filePath.slice(separator + 1)
}

export function fileDirname(filePath: string): string {
  const separator = lastPathSeparatorIndex(filePath)
  if (separator < 0) {
    return '.'
  }
  if (separator === 0) {
    return filePath.slice(0, 1)
  }
  // Keep `C:\` rather than `C:` for a file at the drive root.
  if (separator === 2 && filePath.charAt(1) === ':') {
    return filePath.slice(0, separator + 1)
  }
  return filePath.slice(0, separator)
}

function isPlaceholderName(name: string): name is TerminalQuickCommandPlaceholderName {
  return PLACEHOLDER_NAME_SET.has(name)
}

function lastPathSeparatorIndex(filePath: string): number {
  return Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
}

function filePlaceholderValue(
  name: Exclude<TerminalQuickCommandPlaceholderName, 'workspaceFolder'>,
  context: TerminalQuickCommandPlaceholderContext
): string | null {
  switch (name) {
    case 'file':
      return nonempty(context.filePath)
    case 'relativeFile':
      return nonempty(context.relativePath)
    case 'fileBasename': {
      const path = nonempty(context.filePath)
      return path ? fileBasename(path) : null
    }
    case 'fileDirname': {
      const path = nonempty(context.filePath)
      return path ? fileDirname(path) : null
    }
  }
}

function nonempty(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}
