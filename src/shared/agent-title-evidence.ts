import {
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  containsAgentSpinnerGlyph,
  isClaudeIdentityFrameSegment,
  hasGenericClaudeStatusPrefix,
  isClaudeManagementTitle,
  isCursorNativeAgentTitle
} from './agent-title-core'
import {
  DISPLAY_LABELS,
  agentForBareName,
  agentForIdentityFrame,
  agentForWholeTitle,
  namesIn,
  stripBareNameDecoration
} from './agent-title-name-anchoring'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import { memoizeTitleClassification } from './terminal-title-classification-memo'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { getPiCompatibleSyntheticAgentLabel } from './pi-compatible-synthetic-title'
import {
  SYNTHETIC_AGENT_TITLE_AGENTS,
  SYNTHETIC_AGENT_TITLE_PROFILES
} from './synthetic-agent-title'
import type { TuiAgent } from './tui-agent'

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

const GEMINI_GLYPHS = [GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION]
const ANTIGRAVITY_MODEL_TITLE_RE = /^(?:agy|antigravity)(?:\s*[·—:-]\s*|\s+)gemini\s+\d/i

/**
 * Orca renders `<task text>… - <agent>` and owns the suffix; task text cannot reach past it.
 * Why leading whitespace is required: without it this also matches the tail of a hyphenated
 * worktree name (`review-14600-codex`), which is a directory, not an owner declaration.
 */
const OWNER_SUFFIX_RE = /\s-\s+([A-Za-z][\w-]*)\s*$/
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

/**
 * Every agent a title PRESENTS, as opposed to merely mentions. Memoized as a set rather than
 * per-agent: both tab-strip resolvers ask this per pane on every render.
 */
const titlePresentedAgents = memoizeTitleClassification((title: string): ReadonlySet<TuiAgent> => {
  const evidence = collectAgentTitleEvidence(title)
  const presented = new Set<TuiAgent>(evidence.anchoredNames)

  for (const marker of evidence.vendorMarkers) {
    // Why Claude's marker is excluded and Gemini's and Cursor's are not: a vendor marker is
    // unforgeable only when it is the agent's OWN sigil. Claude's status decorations are generic —
    // OpenCode emits '. ' and '* ' too (#8940) — so they prove activity, not identity. A title
    // that really does present Claude carries an identity frame, which the grammar below matches.
    if (marker !== 'claude' || !hasGenericClaudeStatusPrefix(title)) {
      presented.add(marker)
    }
  }

  for (const segment of getEvidenceTitleSegments(title)) {
    const framed = agentForIdentityFrame(segment)
    if (framed) {
      presented.add(framed)
    }
  }

  return presented
})

/**
 * Whether `title` PRESENTS `agent` as the pane's identity rather than merely mentioning it. This
 * is the gate a title must pass before it may take a pane away from a known owner (#8940) — for
 * every agent, not only Claude.
 *
 * This is NOT collectAgentTitleEvidence with a different signature. The parser answers "who does
 * this title name, given no owner"; this answers "may this title take a pane". The second needs
 * to know WHERE the name sits, which the first discards — `getAgentLabel` mints identity from
 * `titleHasAgentName`, which asks only whether a name occurs anywhere, so one route there covers
 * both `codex working` and `⠋ Fix the codex plugin launcher`. The two models therefore differ on
 * purpose, in both directions, each pinned by test:
 *
 *   more permissive — a name in an identity POSITION is enough here, which admits `⠋ Codex`; the
 *   parser files that as `free-text-only` because codex sets `synthesizeWorkingTitle: false`.
 *
 *   less permissive — the parser resolves a lone vendor marker to its agent, including Claude's
 *   generic status decorations. Those are not identity here, or a `. `-prefixed OpenCode task
 *   title would reclaim the pane #8940 exists to protect.
 *
 * Because they differ, agreement cannot be enforced by sharing code. It is enforced instead by
 * the corpus ratchet in terminal-title-pane-claim-corpus.test.ts, which fails the moment a route
 * `getAgentLabel` mints identity from stops being claimable here.
 */
export function titlePresentsAgent(title: string, agent: TuiAgent): boolean {
  return titlePresentedAgents(title).has(agent)
}
