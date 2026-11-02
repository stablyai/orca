import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  isCursorAgentTitle,
  titleHasAgentName
} from './agent-title-core'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import type { TerminalAgent } from './terminal-agent'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

/** Names matched as whole tokens, paired with the agent each identifies. */
const NAME_TOKENS: readonly (readonly [string, TerminalAgent])[] = [
  ['claude', 'claude'],
  ['openclaude', 'openclaude'],
  ['codex', 'codex'],
  ['jcode', 'jcode'],
  ['copilot', 'copilot'],
  ['cursor', 'cursor'],
  ['gemini', 'gemini'],
  ['antigravity', 'antigravity'],
  ['opencode', 'opencode'],
  ['mimo', 'mimo-code'],
  ['openclaw', 'openclaw'],
  ['aider', 'aider'],
  ['grok', 'grok'],
  ['devin', 'devin']
]

/** Agents whose name is matched by a dedicated pattern rather than a plain token. */
const PATTERN_NAMES: readonly (readonly [RegExp, TerminalAgent])[] = [
  [AGY_AGENT_NAME_RE, 'antigravity'],
  [DROID_AGENT_NAME_RE, 'droid'],
  [HERMES_AGENT_NAME_RE, 'hermes']
]

/** Catalog labels known to be emitted as terminal titles, not merely presented in Orca's UI. */
const EMITTED_DISPLAY_LABEL_AGENTS = [
  'claude-agent-teams',
  'mimo-code',
  'prime-agent',
  'command-code',
  'copilot'
] as const satisfies readonly TerminalAgent[]

const DISPLAY_LABELS = [
  ...EMITTED_DISPLAY_LABEL_AGENTS.map(
    (agent) => [TUI_AGENT_DISPLAY_NAMES[agent].toLowerCase(), agent] as const
  ),
  ['claude code', 'claude'],
  ['gemini cli', 'gemini'],
  ['agent teams', 'claude-agent-teams']
] satisfies readonly (readonly [string, TerminalAgent])[]

const WINDOWS_LAUNCHER_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1)$/i
const RESERVED_OWNER_IDS: ReadonlyMap<string, TerminalAgent> = new Map([
  ['pi', 'pi'],
  ['omp', 'omp'],
  ['claude-agent-teams', 'claude-agent-teams'],
  ['qwen-code', 'qwen-code']
])

export function namesIn(text: string): TerminalAgent[] {
  const found = new Set<TerminalAgent>()
  for (const [token, agent] of NAME_TOKENS) {
    if (titleHasAgentName(text, token)) {
      found.add(agent)
    }
  }
  for (const [pattern, agent] of PATTERN_NAMES) {
    if (pattern.test(text)) {
      found.add(agent)
    }
  }
  return [...found]
}

function stripBareNameDecoration(text: string): string {
  return text
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
}

function agentForBareName(text: string): TerminalAgent | null {
  const trimmed = text.trim()
  if (!trimmed || /[\\/]/.test(trimmed)) {
    return null
  }
  const stripped = stripBareNameDecoration(trimmed)
  // The entire vendor display label makes the same identity claim as a bare agent token.
  const normalized = stripped.toLowerCase()
  const label = DISPLAY_LABELS.find(([text]) => text === normalized)
  if (label) {
    return label[1]
  }
  const bareToken = stripped.replace(WINDOWS_LAUNCHER_SUFFIX_RE, '')
  const names = namesIn(bareToken)
  // Require the whole remainder to be the name; task phrases and hyphenated directories cannot anchor identity.
  return names.length === 1 && /^[\p{L}\p{N}]+$/u.test(bareToken) ? names[0] : null
}

export function agentForWholeTitle(text: string): TerminalAgent | null {
  const trimmed = text.trim()
  if (!trimmed || /[\\/]/.test(trimmed)) {
    return null
  }
  const stripped = stripBareNameDecoration(trimmed)
  const normalized = stripped.toLowerCase()
  const label = DISPLAY_LABELS.find(([text]) => text === normalized)
  if (label) {
    return label[1]
  }
  if (!WINDOWS_LAUNCHER_SUFFIX_RE.test(stripped)) {
    return null
  }
  return agentForBareName(stripped)
}

export function agentForOwnerSuffix(text: string): TerminalAgent | null {
  const normalized = text.trim().toLowerCase()
  return RESERVED_OWNER_IDS.get(normalized) ?? agentForBareName(text)
}

const NATIVE_PAYLOAD_RE = /(?::\s+[\s\S]*|\s*[\u2013\u2014]\s*[\s\S]*)$/
const NATIVE_STATUS_RE =
  /(?:\s+(?:(?:ready|idle|done|working|thinking|running|waiting|permission)|\[(?:ready|idle|done|working|thinking|running|waiting|permission)\])|\s+-\s+action required)$/i

/** Only payload delimiters consume later pipes; bare names/statuses still require the full frame. */
export function agentForNamedTitlePrefix(text: string): TerminalAgent | null {
  const undecorated = stripLeadingAgentTitleDecorationOrEmpty(text).trim()
  const match = NATIVE_PAYLOAD_RE.exec(undecorated)
  return match ? agentForNativeName(undecorated.slice(0, match.index)) : null
}

/** Inspect one disjoint header, preserving shell host/cwd syntax without admitting colon task prose. */
export function isNeutralAgentTitleWrapper(header: string): boolean {
  // ASCII activity tokens include trailing whitespace, so classify before right trimming.
  const lexical = header.trimStart()
  if (stripLeadingAgentTitleDecorationOrEmpty(lexical) !== lexical) {
    return false
  }
  const trimmed = lexical.trim()
  return (
    !trimmed.includes(':') ||
    /^(?:[^\s@:[\]]+@(?:\[[^\]]+\]|[^\s:]+)|\[[^\]\s]+@[^\]\s]+\]):\s*(?:[~/]|[A-Za-z]:[\\/])/.test(
      trimmed
    ) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  )
}

/** Native frames identify an agent by a complete name, a named status, or a name before task text. */
export function agentForNativeFrame(text: string): TerminalAgent | null {
  if (isCursorAgentTitle(text)) {
    return 'cursor'
  }
  const undecorated = stripLeadingAgentTitleDecorationOrEmpty(text).trim()
  const frameName = NATIVE_PAYLOAD_RE.test(undecorated)
    ? undecorated.replace(NATIVE_PAYLOAD_RE, '')
    : undecorated.replace(NATIVE_STATUS_RE, '')
  if (!frameName || /[|>\\/]/.test(frameName)) {
    return null
  }
  return agentForNativeName(frameName)
}

function agentForNativeName(text: string): TerminalAgent | null {
  const normalized = text.replace(WINDOWS_LAUNCHER_SUFFIX_RE, '').toLowerCase()
  if (normalized === 'jcode' || normalized === 'opencode2') {
    return normalized
  }
  const agent = agentForBareName(text)
  // Emitted aliases and Cursor/Pi/OMP use their own closed grammars, not arbitrary named tasks.
  return agent &&
    agent !== 'cursor' &&
    (NAME_TOKENS.some(([, native]) => native === agent) ||
      PATTERN_NAMES.some(([, native]) => native === agent))
    ? agent
    : null
}

/** Shell auto-titles keep arguments as content owned by the command-position name. */
export function agentForShellCommand(text: string): TerminalAgent | null {
  if (text.trim() !== stripLeadingAgentTitleDecorationOrEmpty(text) || /[|>]/.test(text)) {
    return null
  }
  const command = /^(\S+)\s+(?!\[)\S[\s\S]*$/.exec(text.trim())
  return command ? agentForNativeName(command[1]) : null
}

export function namesConsumedByAnchoredLabels(
  segments: readonly string[],
  anchoredNames: ReadonlySet<TerminalAgent>
): Set<TerminalAgent> {
  const consumed = new Set<TerminalAgent>()
  for (const segment of segments) {
    const normalized = stripBareNameDecoration(segment).toLowerCase()
    const label = DISPLAY_LABELS.find(([text]) => text === normalized)
    if (label && anchoredNames.has(label[1])) {
      for (const name of namesIn(label[0])) {
        consumed.add(name)
      }
    }
  }
  return consumed
}
