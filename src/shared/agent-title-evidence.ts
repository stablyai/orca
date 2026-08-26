import {
  AGY_AGENT_NAME_RE,
  CLAUDE_IDLE,
  DROID_AGENT_NAME_RE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  HERMES_AGENT_NAME_RE,
  containsAgentSpinnerGlyph,
  isClaudeIdentityFrameSegment,
  isClaudeManagementTitle,
  isCursorNativeAgentTitle,
  titleHasAgentName
} from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { getPiCompatibleSyntheticAgentLabel } from './pi-compatible-synthetic-title'
import {
  SYNTHETIC_AGENT_TITLE_AGENTS,
  SYNTHETIC_AGENT_TITLE_PROFILES
} from './synthetic-agent-title'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

/**
 * Order-independent identity evidence from a terminal title.
 *
 * The chain this replaces is a first-match-wins scan of substring predicates, so its answer is
 * decided by list position rather than by how strong the evidence is. That is why a Grok pane
 * whose task text mentions Codex reads as Codex, and why fixing one collision by hoisting a
 * branch breaks another. Here every signal is collected first and ranked afterwards, by class:
 *
 *   vendor marker  — a control sequence or sigil the agent itself emits. Task text cannot forge it.
 *   anchored name  — a name in a position some grammar reserves for identity (Orca's `- <agent>`
 *                    owner suffix, or the whole undecorated remainder).
 *   free-text name — a name anywhere else. Anyone can type it.
 *
 * A free-text name never becomes identity on its own, even when it is the only name present: an
 * absent icon is recoverable, a confidently wrong one is not. Callers that only need "is this pane
 * busy" want activity parsing, which lives elsewhere and does not go through here.
 */
export type AgentTitleEvidenceReason =
  | 'anchored'
  | 'vendor-marker'
  | 'conflicting-anchored-names'
  | 'conflicting-vendor-markers'
  | 'free-text-only'
  | 'no-evidence'

export type AgentTitleEvidence = {
  readonly vendorMarkers: readonly TuiAgent[]
  readonly anchoredNames: readonly TuiAgent[]
  readonly freeTextNames: readonly TuiAgent[]
  /** Null whenever the title cannot answer on its own. Callers fall back to stronger signals. */
  readonly agent: TuiAgent | null
  readonly reason: AgentTitleEvidenceReason
}

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

const DISPLAY_LABELS = [
  ...EMITTED_DISPLAY_LABEL_AGENTS.map(
    (agent) => [TUI_AGENT_DISPLAY_NAMES[agent].toLowerCase(), agent] as const
  ),
  ['claude code', 'claude'],
  ['gemini cli', 'gemini'],
  ['agent teams', 'claude-agent-teams']
] satisfies readonly (readonly [string, TuiAgent])[]

const GEMINI_GLYPHS = [GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION]
const ANTIGRAVITY_MODEL_TITLE_RE = /^(?:agy|antigravity)(?:\s*[·—:-]\s*|\s+)gemini\s+\d/i

/**
 * Orca renders `<task text>… - <agent>` and owns the suffix; task text cannot reach past it.
 * Why leading whitespace is required: without it this also matches the tail of a hyphenated
 * worktree name (`review-14600-codex`), which is a directory, not an owner declaration.
 */
const OWNER_SUFFIX_RE = /\s-\s+([A-Za-z][\w-]*)\s*$/
const WINDOWS_LAUNCHER_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1)$/i
const WRAPPER_SEPARATOR = ' | '
const MAX_WRAPPER_EVIDENCE_SEGMENTS = 8
const RESERVED_OWNER_IDS: ReadonlyMap<string, TuiAgent> = new Map([
  ['pi', 'pi'],
  ['omp', 'omp'],
  ['claude-agent-teams', 'claude-agent-teams'],
  ['qwen-code', 'qwen-code']
])

function getEvidenceTitleSegments(title: string): string[] {
  const segments = [title]
  let separatorIndex = title.lastIndexOf(WRAPPER_SEPARATOR)
  while (separatorIndex >= 0 && segments.length < MAX_WRAPPER_EVIDENCE_SEGMENTS) {
    const wrapped = title.slice(separatorIndex + WRAPPER_SEPARATOR.length).trim()
    if (wrapped && !segments.includes(wrapped)) {
      segments.push(wrapped)
    }
    const previousSeparatorIndex = separatorIndex
    separatorIndex = title.lastIndexOf(WRAPPER_SEPARATOR, separatorIndex - 1)
    if (separatorIndex === previousSeparatorIndex) {
      break
    }
  }
  return segments
}

function namesIn(text: string): TuiAgent[] {
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

function stripBareNameDecoration(text: string): string {
  return text
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
}

function agentForBareName(text: string): TuiAgent | null {
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

function agentForWholeTitle(text: string): TuiAgent | null {
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

function agentForOwnerSuffix(text: string): TuiAgent | null {
  const normalized = text.trim().toLowerCase()
  return RESERVED_OWNER_IDS.get(normalized) ?? agentForBareName(text)
}

function agentForSyntheticTitle(text: string): TuiAgent | null {
  const trimmed = text.trim()
  if (/[\\/]/.test(trimmed)) {
    return null
  }
  const normalized = trimmed.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase()
  for (const agent of SYNTHETIC_AGENT_TITLE_AGENTS) {
    const profile = SYNTHETIC_AGENT_TITLE_PROFILES[agent]
    const emittedLabels = [profile.permissionLabel, profile.idleLabel]
    if (profile.synthesizeWorkingTitle !== false) {
      // Working labels are emitted only as spinner frames; a bare name is free text.
      if (
        profile.synthesizeTerminalTitle !== false &&
        containsAgentSpinnerGlyph(trimmed) &&
        normalized === profile.workingLabel.toLowerCase()
      ) {
        return agent
      }
    }
    if (
      profile.synthesizeTerminalTitle !== false &&
      emittedLabels.some((label) => normalized === label.toLowerCase())
    ) {
      return agent
    }
  }
  return null
}

function collectVendorMarkers(segments: readonly string[]): TuiAgent[] {
  const markers = new Set<TuiAgent>()
  for (const segment of segments) {
    // Why prefix-only: a sigil marks the pane's own status line only in the identity position.
    // The same character inside task text is decoration, not a vendor emission.
    if (GEMINI_GLYPHS.some((glyph) => segment.startsWith(glyph))) {
      markers.add('gemini')
    }
    if (
      segment.startsWith(`${CLAUDE_IDLE} `) ||
      segment === CLAUDE_IDLE ||
      segment.startsWith('. ') ||
      segment.startsWith('* ')
    ) {
      markers.add('claude')
    }
    if (isCursorNativeAgentTitle(segment)) {
      markers.add('cursor')
    }
  }
  return [...markers]
}

function namesConsumedByAnchoredLabels(
  segments: readonly string[],
  anchoredNames: ReadonlySet<TuiAgent>
): Set<TuiAgent> {
  const consumed = new Set<TuiAgent>()
  for (const segment of segments) {
    const label = DISPLAY_LABELS.find(
      ([text]) => text === stripBareNameDecoration(segment).toLowerCase()
    )
    if (label && anchoredNames.has(label[1])) {
      for (const name of namesIn(label[0])) {
        consumed.add(name)
      }
    }
  }
  return consumed
}

function collectAnchoredNames(segments: readonly string[]): TuiAgent[] {
  const anchored = new Set<TuiAgent>()

  for (const segment of segments) {
    // Why anchored and not a bare marker: the native envelope owns the whole wrapped pane title.
    // Its session text may name other agents without changing the OpenCode owner.
    if (isOpenCodeNativeTitle(segment)) {
      anchored.add('opencode')
    }

    const suffix = OWNER_SUFFIX_RE.exec(segment)
    if (suffix) {
      const agent = agentForOwnerSuffix(suffix[1])
      if (agent) {
        anchored.add(agent)
      }
    }

    // Why strip a leading vendor sigil first: `✳ agy` is a Claude-glyphed pane whose entire
    // remainder is another agent's name — the strongest name evidence a title can carry.
    const withoutSigil = segment.startsWith(`${CLAUDE_IDLE} `)
      ? segment.slice(CLAUDE_IDLE.length)
      : segment
    const bare = agentForWholeTitle(withoutSigil)
    if (bare) {
      anchored.add(bare)
    }
    const synthetic = agentForSyntheticTitle(segment)
    if (synthetic) {
      anchored.add(synthetic)
    }
    if (isClaudeIdentityFrameSegment(segment)) {
      anchored.add('claude')
    }

    // Why Antigravity gets a grammar: its models are named `Gemini <n.n> <Name>`, so an agy pane's
    // own title carries a whole `gemini` token. Read as identity-plus-model, the gemini token is
    // metadata — which is the general rule, not an exception inside the Gemini detector.
    const undecorated = stripLeadingAgentTitleDecorationOrEmpty(segment).trim()
    if (ANTIGRAVITY_MODEL_TITLE_RE.test(undecorated)) {
      anchored.add('antigravity')
    }

    const piCompatible = getPiCompatibleSyntheticAgentLabel(segment)
    if (piCompatible === 'Pi') {
      anchored.add('pi')
    } else if (piCompatible === 'OMP') {
      anchored.add('omp')
    }
  }

  return [...anchored]
}

/** Collects every identity signal in `title` and ranks them by class, never by declaration order. */
export function collectAgentTitleEvidence(title: string): AgentTitleEvidence {
  const empty = { vendorMarkers: [], anchoredNames: [], freeTextNames: [] } as const
  if (!title.trim() || isClaudeManagementTitle(title)) {
    // Why: a `claude agents` management screen is Claude's own UI, not an agent session.
    return { ...empty, agent: null, reason: 'no-evidence' }
  }

  const segments = getEvidenceTitleSegments(title)
  const vendorMarkers = collectVendorMarkers(segments)
  const anchoredNames = collectAnchoredNames(segments)
  const anchoredSet = new Set(anchoredNames)
  const anchoredLabelNames = namesConsumedByAnchoredLabels(segments, anchoredSet)
  const freeTextNames = namesIn(title).filter(
    (agent) => !anchoredSet.has(agent) && !anchoredLabelNames.has(agent)
  )
  const evidence = { vendorMarkers, anchoredNames, freeTextNames } as const

  if (anchoredNames.length === 1) {
    // Why anchored beats a vendor marker: `✳ agy` is an agy pane whose title kept Claude's sigil.
    return { ...evidence, agent: anchoredNames[0], reason: 'anchored' }
  }
  if (anchoredNames.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-anchored-names' }
  }
  if (vendorMarkers.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-vendor-markers' }
  }
  if (vendorMarkers.length === 1) {
    // Why free text does not veto here: `✳ Fix Codex false attention notifications` is a Claude
    // pane describing Codex work. The sigil is emitted by the agent; the name was typed by a
    // human. A conflicting ANCHORED name already outranks this branch above, which is what makes
    // `✳ agy` resolve to Antigravity without also blinding the 13 recorded titles of this shape.
    return { ...evidence, agent: vendorMarkers[0], reason: 'vendor-marker' }
  }
  return {
    ...evidence,
    agent: null,
    reason: freeTextNames.length > 0 ? 'free-text-only' : 'no-evidence'
  }
}
