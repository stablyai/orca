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

/** Merges persisted session directories with `--add-dir` entries from default agent args. */
export function resolveAdditionalDirectoriesFromLaunch(
  recordDirectories: readonly string[] | undefined,
  defaultArgs: string | undefined,
  shell?: AgentStartupShell
): string[] | undefined {
  return normalizeAdditionalDirectories([
    ...(recordDirectories ?? []),
    ...extractAdditionalDirectoriesFromArgs(defaultArgs, shell)
  ])
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
