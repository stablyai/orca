import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAgentName
} from './agent-title-core'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import {
  getPiCompatibleSyntheticAgentLabel,
  isLegacyPiCompatibleTitle
} from './pi-compatible-synthetic-title'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

/**
 * The vocabulary that maps a piece of title text to the agent it names, and the position tests
 * that decide whether that text NAMES the agent or merely mentions it.
 *
 * Split out of agent-title-evidence.ts so the evidence parser and `titlePresentsAgent` resolve
 * names through one implementation. They ask different questions — "who does this title name"
 * versus "does this title present THIS agent" — and the whole class of bug in #8940/#14937 comes
 * from those questions drifting apart, so the part they agree on lives in exactly one place.
 */

const WINDOWS_LAUNCHER_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1)$/i

/** Names matched as whole tokens, paired with the agent each identifies. */
const NAME_TOKENS: readonly (readonly [string, TuiAgent])[] = [
  ['claude', 'claude'],
  ['openclaude', 'openclaude'],
  ['codex', 'codex'],
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
const PATTERN_NAMES: readonly (readonly [RegExp, TuiAgent])[] = [
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
] as const satisfies readonly TuiAgent[]

export const DISPLAY_LABELS = [
  ...EMITTED_DISPLAY_LABEL_AGENTS.map(
    (agent) => [TUI_AGENT_DISPLAY_NAMES[agent].toLowerCase(), agent] as const
  ),
  ['claude code', 'claude'],
  ['gemini cli', 'gemini'],
  ['agent teams', 'claude-agent-teams']
] satisfies readonly (readonly [string, TuiAgent])[]

export function namesIn(text: string): TuiAgent[] {
  const found = new Set<TuiAgent>()
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

export function stripBareNameDecoration(text: string): string {
  return text
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
}

export function agentForBareName(text: string): TuiAgent | null {
  const trimmed = text.trim()
  if (!trimmed || /[\\/]/.test(trimmed)) {
    return null
  }
  const stripped = stripBareNameDecoration(trimmed)
  // Why labels too: an agent may write its own display name as the entire title (`⠐ Claude Code`).
  // That is the same claim as a bare token, just spelled the way the vendor spells it.
  const label = DISPLAY_LABELS.find(([text]) => text === stripped.toLowerCase())
  if (label) {
    return label[1]
  }
  const bareToken = stripped.replace(WINDOWS_LAUNCHER_SUFFIX_RE, '')
  const names = namesIn(bareToken)
  // Why the length check: the remainder must BE the name, not merely contain it. "agy" anchors;
  // "fix the agy hook" does not, and neither does a hyphenated worktree name like "codex-split".
  return names.length === 1 && /^[\p{L}\p{N}]+$/u.test(bareToken) ? names[0] : null
}

export function agentForWholeTitle(text: string): TuiAgent | null {
  const trimmed = text.trim()
  if (!trimmed || /[\\/]/.test(trimmed)) {
    return null
  }
  const stripped = stripBareNameDecoration(trimmed)
  const label = DISPLAY_LABELS.find(([text]) => text === stripped.toLowerCase())
  if (label) {
    return label[1]
  }
  if (!WINDOWS_LAUNCHER_SUFFIX_RE.test(stripped)) {
    return null
  }
  return agentForBareName(stripped)
}

/** Status words an agent appends to its own name in a title frame. */
const IDENTITY_FRAME_STATUS_RE = /\s+(?:ready|idle|done|working|thinking|running|waiting|blocked)$/i
const IDENTITY_FRAME_ACTION_RE = /\s*[-–—]\s*action required$/i
/**
 * The frame head: everything before the first separator an agent puts after its own name.
 *
 * Deliberately excludes '|'. Wrappers PREFIX the pane's title and the innermost title comes LAST
 * (terminal-title-wrapper-segments.ts), so a name before a '|' is a tmux window or ssh host, not
 * the pane — reading it as identity hands a Codex pane in a window named `claude` to Claude, which
 * is this change's own bug inverted. Wrapper-joined titles reach the real pane title through
 * getEvidenceTitleSegments' suffix splitting instead, which is what resolves `ssh host | opencode
 * ready`. '>' is excluded for the same reason it is unnecessary: Pi's native `π > session` form is
 * matched by the branch above, before this regex runs.
 */
const IDENTITY_FRAME_HEAD_RE = /^([^:—–]+?)(?:\s*[:—–]|$)/

/**
 * The agent a single title segment PRESENTS by putting its name in an identity position, as
 * opposed to mentioning it inside task text.
 *
 * This generalizes the grammar `isClaudeIdentityFrameSegment` has always described — a name, an
 * optional status word, an optional "- action required" — which was agent-neutral in shape and
 * applied only to Claude. Every route `computeAgentLabel` mints identity from is a case of it:
 * a bare name, `Codex: …`, `⠉ Codex — refactoring`, `codex working` and `aider.ps1 ready`. What
 * it will not match is a name in the middle of a sentence, nor a name in a wrapper prefix —
 * the two forgeable routes, and the whole reason this gate exists.
 */
export function agentForIdentityFrame(segment: string): TuiAgent | null {
  // Pi and OMP print their own native format, which is not a name-plus-decoration shape at all.
  const piCompatible = getPiCompatibleSyntheticAgentLabel(segment)
  if (piCompatible) {
    return piCompatible === 'OMP' ? 'omp' : 'pi'
  }
  if (isLegacyPiCompatibleTitle(segment)) {
    return 'pi'
  }
  const undecorated = stripLeadingAgentTitleDecorationOrEmpty(segment).trim()
  const head = IDENTITY_FRAME_HEAD_RE.exec(undecorated)?.[1]?.trim()
  if (!head) {
    return null
  }
  return agentForBareName(
    head.replace(IDENTITY_FRAME_ACTION_RE, '').replace(IDENTITY_FRAME_STATUS_RE, '').trim()
  )
}
