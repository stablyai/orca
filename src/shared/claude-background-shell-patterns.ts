import type { GlobalSettings } from './global-settings-types'

/** Commands with no natural exit condition: still running at turn end means the agent
 *  launched and walked away, not that it is waiting for a result. Tokens beat binary
 *  names — `--watch`/`dev`/`serve` generalize across ecosystems a name list can't cover. */
export const DEFAULT_CLAUDE_BACKGROUND_SHELL_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  'dev',
  'serve',
  'runserver',
  'watch',
  '--watch',
  '--reload',
  '--follow',
  'nodemon',
  'ngrok',
  'http-server',
  'uvicorn',
  'gunicorn',
  'caddy',
  'mongod',
  'redis-server',
  'tail',
  'journalctl'
])

// Why: bound user-supplied config so a pathological list can't cost per-hook time.
const MAX_PATTERNS = 100
const MAX_PATTERN_LEN = 64
const MAX_COMMAND_SCAN_LEN = 4_096

/** Trims, lowercases, dedupes and caps a raw pattern list from settings or the wire. */
export function normalizeClaudeBackgroundShellIgnorePatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const cleaned = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((pattern) => pattern.length > 0 && pattern.length <= MAX_PATTERN_LEN)
  return [...new Set(cleaned)].slice(0, MAX_PATTERNS)
}

// Why: shell quoting and trailing separators would otherwise hide a token (`'daemon` != `daemon`).
function stripTokenPunctuation(token: string): string {
  return token.replace(/^['"`]+|['"`;,]+$/g, '')
}

/** True when the command looks like one of the never-terminating patterns. Single-word
 *  patterns match a whole token so `dev` can't fire on `dev-smoke-test.sh`; a pattern
 *  containing a space matches as a phrase. */
export function claudeBackgroundShellCommandMatches(
  command: unknown,
  patterns: readonly string[]
): boolean {
  if (patterns.length === 0 || typeof command !== 'string' || command.length === 0) {
    return false
  }
  const normalized = command.slice(0, MAX_COMMAND_SCAN_LEN).toLowerCase()
  const tokens = new Set(
    normalized
      .split(/\s+/)
      .map(stripTokenPunctuation)
      .filter((token) => token.length > 0)
  )
  return patterns.some((pattern) =>
    pattern.includes(' ') ? normalized.includes(pattern) : tokens.has(pattern)
  )
}

/** The patterns a host should actually apply. Empty unless the user opted in, which is
 *  what keeps the default behavior (every running shell holds the turn) intact. */
export function resolveClaudeBackgroundShellIgnorePatterns(
  settings:
    | Pick<
        GlobalSettings,
        'agentStatusIgnoresBackgroundShells' | 'agentStatusBackgroundShellIgnorePatterns'
      >
    | null
    | undefined
): string[] {
  if (settings?.agentStatusIgnoresBackgroundShells !== true) {
    return []
  }
  return normalizeClaudeBackgroundShellIgnorePatterns(
    settings.agentStatusBackgroundShellIgnorePatterns ??
      DEFAULT_CLAUDE_BACKGROUND_SHELL_IGNORE_PATTERNS
  )
}
