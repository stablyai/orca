import type { RepoFormatOnSaveSettings } from './repo-types'
import { normalizeRuntimePathSeparators } from './cross-platform-path'
import { escapeRegex } from './string-utils'
import { expandCommandTokens } from './format-on-save-command-expansion'

/** Shown in Settings as placeholders; these are command/glob syntax, not UI copy. */
export const SUGGESTED_FORMAT_ON_SAVE_INCLUDE = '**/*.{ts,tsx,js,jsx,json,css,md}'
export const SUGGESTED_FORMAT_ON_SAVE_COMMAND = 'npx prettier --write ${file}'

export {
  FORMAT_ON_SAVE_FILE_TOKEN,
  FORMAT_ON_SAVE_RELATIVE_FILE_TOKEN,
  FormatOnSaveCommandError
} from './format-on-save-command-expansion'

export type FormatOnSaveSkipReason =
  | 'not-configured'
  | 'not-included'
  | 'outside-worktree'
  | 'already-running'
  /** Runtime hosts, and SSH hosts whose relay is down, have no exec channel to reach the file. */
  | 'unsupported-host'

export type FormatOnSaveResult =
  | { status: 'completed' }
  | { status: 'skipped'; reason: FormatOnSaveSkipReason }
  | { status: 'failed'; message: string }

export function getDefaultRepoFormatOnSaveSettings(): RepoFormatOnSaveSettings {
  return { enabled: false, command: '', include: [] }
}

export function normalizeRepoFormatOnSaveSettings(value: unknown): RepoFormatOnSaveSettings {
  const raw = (value ?? {}) as Partial<RepoFormatOnSaveSettings>
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const include = Array.isArray(raw.include)
    ? raw.include
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : []

  return {
    // Why: a command-less config would run nothing every save; treat it as off so callers can skip work early.
    enabled: raw.enabled === true && command.length > 0,
    command,
    include
  }
}

/**
 * Settings shows the globs as one comma-separated line; newlines are accepted for pasted lists.
 * Commas inside a `{a,b}` group belong to the glob, so only top-level ones split.
 */
export function parseFormatOnSaveIncludeInput(value: string): string[] {
  const entries: string[] = []
  let current = ''
  let braceDepth = 0

  for (const char of value) {
    if (char === '\n') {
      // Why: a line is always a boundary, so a stray `{` cannot swallow the lines after it.
      braceDepth = 0
      entries.push(current)
      current = ''
    } else if (char === ',' && braceDepth === 0) {
      entries.push(current)
      current = ''
    } else {
      if (char === '{') {
        braceDepth++
      } else if (char === '}' && braceDepth > 0) {
        braceDepth--
      }
      current += char
    }
  }
  entries.push(current)

  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

export function formatOnSaveIncludeToInput(include: string[]): string {
  return include.join(', ')
}

export function isFormatOnSaveConfigured(
  settings: RepoFormatOnSaveSettings | undefined | null
): boolean {
  return settings?.enabled === true && settings.command.trim().length > 0
}

/**
 * `include` semantics: empty list matches every saved file. A pattern without a
 * `/` matches the basename in any directory, which is what users reach for when
 * they type `*.ts`.
 */
export function matchesFormatOnSaveInclude(relativePath: string, include: string[]): boolean {
  if (include.length === 0) {
    return true
  }

  const normalized = normalizeRuntimePathSeparators(relativePath).replace(/^\.?\//, '')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)

  return include.some((pattern) => {
    const normalizedPattern = normalizeRuntimePathSeparators(pattern).replace(/^\.?\//, '')
    const target = normalizedPattern.includes('/') ? normalized : basename
    return globToRegExp(normalizedPattern).test(target)
  })
}

const globRegExpCache = new Map<string, RegExp>()
const GLOB_CACHE_LIMIT = 256

function globToRegExp(pattern: string): RegExp {
  const cached = globRegExpCache.get(pattern)
  if (cached) {
    return cached
  }

  const compiled = new RegExp(`^${compileGlobBody(pattern)}$`)
  if (globRegExpCache.size >= GLOB_CACHE_LIMIT) {
    globRegExpCache.clear()
  }
  globRegExpCache.set(pattern, compiled)
  return compiled
}

function compileGlobBody(pattern: string): string {
  let source = ''

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]

    if (char === '*') {
      const isDoubleStar = pattern[index + 1] === '*'
      if (isDoubleStar) {
        index++
        if (pattern[index + 1] === '/') {
          index++
          // Why: `**/x` must also match a root-level `x`, so the directory prefix is optional.
          source += '(?:.*/)?'
          continue
        }
        source += '.*'
        continue
      }
      source += '[^/]*'
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    if (char === '{') {
      const closingIndex = pattern.indexOf('}', index)
      if (closingIndex !== -1) {
        const alternatives = pattern.slice(index + 1, closingIndex).split(',')
        source += `(?:${alternatives.map((alternative) => compileGlobBody(alternative)).join('|')})`
        index = closingIndex
        continue
      }
    }

    // Why: `*` and `?` are consumed above, so whatever reaches here is a literal.
    source += escapeRegex(char)
  }

  return source
}

type FormatOnSaveCommandExpansion = {
  command: string
  absolutePath: string
  relativePath: string
  platform: NodeJS.Platform
}

/**
 * Substitutes the path tokens with values quoted for the shell context they sit
 * in. A command without any token is left alone — some formatters take the whole
 * project. Throws FormatOnSaveCommandError for a path that cannot be quoted safely.
 */
export function expandFormatOnSaveCommand({
  command,
  absolutePath,
  relativePath,
  platform
}: FormatOnSaveCommandExpansion): string {
  return expandCommandTokens(command, { file: absolutePath, relativeFile: relativePath }, platform)
}
