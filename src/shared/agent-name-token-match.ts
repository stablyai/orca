/** Match whole title tokens so cwd paths and hyphenated names cannot classify as another agent. */

// OSC inference uses a narrow name set to avoid shell-title false positives from short names such as amp; telemetry uses explicit launch/session facts.
export const AGENT_NAMES = [
  'claude',
  'openclaude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'antigravity',
  'opencode',
  'opencode2',
  'mimo',
  'openclaw',
  'aider',
  'grok',
  'devin',
  'zcode',
  'jcode'
]

// Allow Windows launcher suffixes such as openclaude.exe while rejecting arbitrary dotted paths.
const WINDOWS_EXECUTABLE_SUFFIX_RE = String.raw`(?:\.(?:exe|cmd|bat|ps1))`

export function buildAgentNameRe(name: string): RegExp {
  return new RegExp(
    `(?:^|[^\\w./\\\\-])${name}(?:${WINDOWS_EXECUTABLE_SUFFIX_RE})?(?![\\w./\\\\-])`,
    'i'
  )
}

const AGENT_NAME_RE_BY_NAME = new Map(AGENT_NAMES.map((name) => [name, buildAgentNameRe(name)]))

const ANY_LEGACY_AGENT_NAME_RE = new RegExp(
  AGENT_NAMES.map(
    (name) => `(?:^|[^\\w./\\\\-])${name}(?:${WINDOWS_EXECUTABLE_SUFFIX_RE})?(?![\\w./\\\\-])`
  ).join('|'),
  'i'
)

export function titleHasAgentName(title: string, name: string): boolean {
  return AGENT_NAME_RE_BY_NAME.get(name)?.test(title) ?? false
}

export function titleHasAnyLegacyAgentName(title: string): boolean {
  return ANY_LEGACY_AGENT_NAME_RE.test(title)
}

// Whole tokens keep Android titles from matching Droid.
export const DROID_AGENT_NAME_RE = /(?:^|[^\w./\\-])droid(?![\w./\\-])/i

// Reject Hermes/agy substrings inside cwd/path titles.
export const HERMES_AGENT_NAME_RE = /(?:^|[^\w./\\-])hermes(?![\w./\\-])/i
export const AGY_AGENT_NAME_RE = /(?:^|[^\w./\\-])agy(?![\w./\\-])/i
