import {
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  containsAgentSpinnerGlyph,
  isClaudeIdentityFrameSegment,
  isClaudeManagementTitle,
  isCursorNativeAgentTitle,
  isGrokRotatingWorkingTitle
} from './agent-title-core'
import {
  isOpenCodeNativeTitle,
  isOpenCodeNativeTitleHeader,
  isDirectOpenCodeNativeTitle
} from './opencode-terminal-title'
import {
  hasDeepSeekBuildWorkingTitlePrefix,
  isDeepSeekBuildWorkingTitle,
  isDeepSeekBuildTerminalTitle
} from './dsb-terminal-title'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import {
  getPiCompatibleSyntheticAgentLabel,
  getPiCompatibleTitleBrand,
  isLegacyPiCompatibleTitle
} from './pi-compatible-synthetic-title'
import { isDshTerminalTitle } from './dsh-terminal-title'
import { hasQoderTitleLabelPayload, isQoderTerminalTitle } from './qoder-terminal-title'
import {
  SYNTHETIC_AGENT_TITLE_AGENTS,
  SYNTHETIC_AGENT_TITLE_PROFILES
} from './synthetic-agent-title'
import type { TerminalAgent } from './terminal-agent'
import {
  agentForNativeFrame,
  agentForNamedTitlePrefix,
  isNeutralAgentTitleWrapper,
  agentForOwnerSuffix,
  agentForShellCommand,
  agentForWholeTitle,
  namesConsumedByAnchoredLabels,
  namesIn
} from './agent-title-name-anchoring'

/** Collect before ranking: anchored identity names outrank vendor glyphs, which outrank free-text mentions. Free text alone never identifies a pane; prefer no icon to a wrong one. Activity parsing handles generic busy signals separately. */
export type AgentTitleEvidenceReason =
  | 'anchored'
  | 'vendor-marker'
  | 'conflicting-anchored-names'
  | 'conflicting-vendor-markers'
  | 'free-text-only'
  | 'no-evidence'

export type AgentTitleEvidence = {
  readonly vendorMarkers: readonly TerminalAgent[]
  readonly anchoredNames: readonly TerminalAgent[]
  readonly freeTextNames: readonly TerminalAgent[]
  /** Null whenever the title cannot answer on its own. Callers fall back to stronger signals. */
  readonly agent: TerminalAgent | null
  readonly reason: AgentTitleEvidenceReason
}

const GEMINI_GLYPHS = [GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION]
const ANTIGRAVITY_MODEL_TITLE_RE = /^(?:agy|antigravity)(?:\s*[\u00B7\u2014:-]\s*|\s+)gemini\s+\d/i

/** Orca owns the final - <agent> suffix. Require leading whitespace to avoid treating hyphenated cwd names as ownership. */
const OWNER_SUFFIX_RE = /\s-\s+([A-Za-z][\w-]*)\s*$/
const WRAPPER_SEPARATOR = ' | '
const MAX_WRAPPER_EVIDENCE_SEGMENTS = 8

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

function agentForSyntheticTitle(text: string): TerminalAgent | null {
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

function collectVendorMarkers(segments: readonly string[]): TerminalAgent[] {
  const markers = new Set<TerminalAgent>()
  for (const segment of segments) {
    // Only a leading identity-position sigil counts; the same glyph inside task text is decoration.
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

function collectAnchoredNames(
  segments: readonly string[],
  vendorMarkers: readonly TerminalAgent[]
): TerminalAgent[] {
  const anchored = new Set<TerminalAgent>()
  // Why: a native owner's task text can end with DSB's product-name suffix, including inside wrappers.
  const nativeOpenCode = segments.some(isOpenCodeNativeTitle)
  const allowDsbTitle = vendorMarkers.length === 0 && !nativeOpenCode

  for (const segment of segments) {
    // Native wrapped titles own their envelope even when session text names other agents.
    if (isOpenCodeNativeTitle(segment)) {
      anchored.add('opencode')
    }
    if (allowDsbTitle && isDeepSeekBuildTerminalTitle(segment)) {
      anchored.add('dsb')
    }

    const suffix = OWNER_SUFFIX_RE.exec(segment)
    if (suffix) {
      const agent = agentForOwnerSuffix(suffix[1])
      if (agent) {
        anchored.add(agent)
      }
    }

    // Strip the leading sigil to expose anchored names: in ✳ agy, the name outranks the inherited Claude glyph.
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

    // Parse agy identity plus Gemini model metadata structurally instead of giving Gemini a competitor-specific exception.
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

/** Only neutral headers advance; payload pipes never become candidates. */
function observerFrameStart(title: string): number {
  let start = 0
  let boundary = title.indexOf(WRAPPER_SEPARATOR)
  while (boundary >= 0) {
    // Retain the separator's first space for whitespace-delimited native brands.
    const header = title.slice(start, boundary + 1)
    const undecorated = stripLeadingAgentTitleDecorationOrEmpty(header).trim()
    const neutralWrapper = isNeutralAgentTitleWrapper(header)
    if (
      isOpenCodeNativeTitleHeader(header) ||
      hasQoderTitleLabelPayload(header) ||
      undecorated.startsWith('🐋') ||
      getPiCompatibleTitleBrand(header) ||
      isLegacyPiCompatibleTitle(header) ||
      hasDeepSeekBuildWorkingTitlePrefix(header) ||
      agentForNamedTitlePrefix(header) ||
      ANTIGRAVITY_MODEL_TITLE_RE.test(undecorated) ||
      !neutralWrapper
    ) {
      break
    }
    start = boundary + WRAPPER_SEPARATOR.length
    boundary = title.indexOf(WRAPPER_SEPARATOR, start)
  }
  return start
}

/** Evaluate the sole unconsumed remainder, keeping the independent final owner suffix. */
function collectObserverAnchors(title: string): TerminalAgent[] {
  const anchored = new Set<TerminalAgent>()
  const suffix = OWNER_SUFFIX_RE.exec(title)
  const suffixAgent = suffix ? agentForOwnerSuffix(suffix[1]) : null
  if (suffixAgent) {
    anchored.add(suffixAgent)
  }
  const segment = title.slice(observerFrameStart(title)).trim()
  const undecorated = stripLeadingAgentTitleDecorationOrEmpty(segment).trim()
  const nativeOpenCode = isOpenCodeNativeTitle(segment)
  const piBrand = getPiCompatibleTitleBrand(segment)
  const genericClaude =
    segment === CLAUDE_IDLE ||
    segment.startsWith(`${CLAUDE_IDLE} `) ||
    segment.startsWith('. ') ||
    segment.startsWith('* ')
  let agent: TerminalAgent | null
  if (!genericClaude && nativeOpenCode && isDirectOpenCodeNativeTitle(segment)) {
    agent = 'opencode'
  } else if (isDshTerminalTitle(segment) && undecorated.startsWith('🐋')) {
    agent = 'dsh'
  } else if (isQoderTerminalTitle(segment)) {
    agent = segment.includes('Qoder CLI CN') ? 'qoder-cn' : 'qoder'
  } else if (piBrand || isLegacyPiCompatibleTitle(segment)) {
    agent = piBrand === 'OMP' ? 'omp' : 'pi'
  } else if (GEMINI_GLYPHS.some((glyph) => segment.startsWith(glyph))) {
    agent = 'gemini'
  } else if (genericClaude) {
    agent = agentForNativeFrame(segment) === 'claude' ? 'claude' : null
  } else {
    agent =
      (isGrokRotatingWorkingTitle(segment) ? 'grok' : null) ??
      (isDeepSeekBuildWorkingTitle(segment) ||
      (!segment.includes('|') && isDeepSeekBuildTerminalTitle(segment))
        ? 'dsb'
        : null) ??
      agentForNativeFrame(segment) ??
      agentForWholeTitle(segment) ??
      agentForSyntheticTitle(segment) ??
      (ANTIGRAVITY_MODEL_TITLE_RE.test(undecorated) ? 'antigravity' : null) ??
      (getPiCompatibleSyntheticAgentLabel(segment) === 'OMP'
        ? 'omp'
        : getPiCompatibleSyntheticAgentLabel(segment) === 'Pi'
          ? 'pi'
          : null) ??
      (!suffixAgent ? agentForShellCommand(segment) : null)
  }
  if (agent) {
    anchored.add(agent)
  }
  return [...anchored]
}

/** Collects every identity signal in `title` and ranks them by class, never by declaration order. */
function collectTitleEvidence(title: string, nativeFrames: boolean): AgentTitleEvidence {
  const empty = { vendorMarkers: [], anchoredNames: [], freeTextNames: [] } as const
  if (!title.trim() || isClaudeManagementTitle(title)) {
    // Why: a `claude agents` management screen is Claude's own UI, not an agent session.
    return { ...empty, agent: null, reason: 'no-evidence' }
  }

  const segments = getEvidenceTitleSegments(title)
  const vendorMarkers = collectVendorMarkers(segments)
  const anchoredNames = nativeFrames
    ? collectObserverAnchors(title)
    : collectAnchoredNames(segments, vendorMarkers)
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
  if (!nativeFrames && vendorMarkers.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-vendor-markers' }
  }
  if (!nativeFrames && vendorMarkers.length === 1) {
    // Free-text names cannot veto a vendor glyph (✳ Fix Codex… is Claude); a conflicting anchored name already outranks it.
    return { ...evidence, agent: vendorMarkers[0], reason: 'vendor-marker' }
  }
  return {
    ...evidence,
    agent: null,
    reason: freeTextNames.length > 0 ? 'free-text-only' : 'no-evidence'
  }
}

/** Canonical host evidence retains its existing conservative title vocabulary. */
export function collectAgentTitleEvidence(title: string): AgentTitleEvidence {
  return collectTitleEvidence(title, false)
}

/** Hookless terminal readers also admit native named frames, but generic Claude activity cannot claim identity. */
export function collectExplicitAgentTitleEvidence(title: string): AgentTitleEvidence {
  return collectTitleEvidence(title, true)
}
