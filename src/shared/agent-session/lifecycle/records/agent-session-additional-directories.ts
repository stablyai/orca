import { findOptionOccurrence } from '../../../cli/command-option-occurrence'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../agent-launch/startup/tui-agent-startup-shell'
import { MAX_PATH_LENGTH } from '../accounts/agent-session-account-home'

const MAX_ADDITIONAL_DIRECTORIES = 64

/** Deduplicates non-empty directory entries while preserving first-seen order. */
export function normalizeAdditionalDirectories(
  directories: readonly string[] | undefined
): string[] | undefined {
  if (!directories?.length) {
    return undefined
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const directory of directories) {
    const trimmed = directory.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result.length > 0 ? result : undefined
}

/** Extracts deduplicated `--add-dir` / `-add-dir` values from configured agent args, preserving order. */
export function extractAdditionalDirectoriesFromArgs(
  rawArgs: string | undefined,
  shell: AgentStartupShell = typeof process !== 'undefined' && process.platform === 'win32'
    ? 'powershell'
    : 'posix'
): string[] {
  const text = rawArgs?.trim()
  if (!text) {
    return []
  }
  const tokenized = tokenizeStartupCommand(text, shell)
  if (!tokenized.ok) {
    return []
  }
  const directories: string[] = []
  const { tokens } = tokenized
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      break
    }
    const occurrence = findOptionOccurrence(
      tokens.slice(index, index + 2),
      ['--add-dir', '-add-dir'],
      false
    )
    if (occurrence?.index === 0) {
      if (occurrence.value) {
        directories.push(occurrence.value)
      }
      index += occurrence.consumed - 1
    }
  }
  return normalizeAdditionalDirectories(directories) ?? []
}

export function isAbsoluteDirectoryPath(directory: string): boolean {
  return (
    directory.startsWith('/') || /^[A-Za-z]:[/\\]/.test(directory) || directory.startsWith('\\\\')
  )
}

function normalizePosixSegments(raw: string): string {
  const stack: string[] = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}

function resolveDirectoryAgainstCwd(directory: string, cwd: string): string {
  const driveMatch = /^([A-Za-z]:)([/\\].*)$/.exec(cwd)
  const uncMatch = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(.*)$/.exec(cwd)
  const dirDriveRelative = /^([A-Za-z]:)([^/\\].*)$/.exec(directory)

  if (
    /^[A-Za-z]:[/\\]/.test(directory) ||
    directory.startsWith('\\\\') ||
    directory.startsWith('//')
  ) {
    return directory
  }
  if (driveMatch) {
    const [, cwdDrive, cwdRest] = driveMatch
    if (directory.startsWith('\\') || directory.startsWith('/')) {
      return `${cwdDrive}${normalizePosixSegments(directory.replaceAll('\\', '/')).replaceAll('/', '\\')}`
    }
    if (dirDriveRelative) {
      if (dirDriveRelative[1].toLowerCase() !== cwdDrive.toLowerCase()) {
        throw new Error(
          `Cannot resolve drive-relative directory "${directory}" against "${cwd}". Use an absolute path.`
        )
      }
      const joined = `${cwdRest.replaceAll('\\', '/')}/${dirDriveRelative[2].replaceAll('\\', '/')}`
      return `${cwdDrive}${normalizePosixSegments(joined).replaceAll('/', '\\')}`
    }
    const joined = `${cwdRest.replaceAll('\\', '/')}/${directory.replaceAll('\\', '/')}`
    return `${cwdDrive}${normalizePosixSegments(joined).replaceAll('/', '\\')}`
  }
  if (uncMatch) {
    if (dirDriveRelative) {
      throw new Error(
        `Cannot resolve drive-relative directory "${directory}" against "${cwd}". Use an absolute path.`
      )
    }
    const shareRoot = `\\\\${uncMatch[1]}\\${uncMatch[2]}`
    const base =
      directory.startsWith('\\') || directory.startsWith('/')
        ? directory
        : `${uncMatch[3]}/${directory}`
    const tail = normalizePosixSegments(base.replaceAll('\\', '/')).slice(1).replaceAll('/', '\\')
    return tail ? `${shareRoot}\\${tail}` : shareRoot
  }
  if (directory.startsWith('/')) {
    return directory
  }
  if (dirDriveRelative) {
    throw new Error(
      `Cannot resolve drive-relative directory "${directory}" against "${cwd}". Use an absolute path.`
    )
  }
  return normalizePosixSegments(`${cwd}/${directory}`)
}

/** Merges persisted session directories with `--add-dir` entries, resolves relative defaults against `cwd`, and enforces the 64-entry bound. */
export function resolveAdditionalDirectoriesFromLaunch(
  recordDirectories: readonly string[] | undefined,
  defaultArgs: string | undefined,
  cwd?: string,
  shell?: AgentStartupShell
): string[] | undefined {
  const combined = [
    ...(recordDirectories ?? []),
    ...extractAdditionalDirectoriesFromArgs(defaultArgs, shell)
  ]
  const resolved = cwd
    ? combined.map((directory) => {
        const trimmed = directory.trim()
        return trimmed ? resolveDirectoryAgainstCwd(trimmed, cwd) : trimmed
      })
    : combined
  const normalized = normalizeAdditionalDirectories(resolved)
  if (normalized && normalized.length > MAX_ADDITIONAL_DIRECTORIES) {
    throw new Error(
      `Too many additional directories (${normalized.length}); maximum allowed is ${MAX_ADDITIONAL_DIRECTORIES}.`
    )
  }
  return normalized
}

export function isAgentSessionAdditionalDirectories(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ADDITIONAL_DIRECTORIES &&
    value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= MAX_PATH_LENGTH &&
        !entry.includes('\0')
    )
  )
}
