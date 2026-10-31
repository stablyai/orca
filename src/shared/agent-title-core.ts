import {
  GEMINI_WORKING,
  GEMINI_SILENT_WORKING,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  containsBrailleSpinner
} from './agent-title-glyphs'
export {
  CLAUDE_IDLE,
  GEMINI_WORKING,
  GEMINI_SILENT_WORKING,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  BRAILLE_SPINNER_RE,
  QUARTER_CIRCLE_SPINNER_RE,
  containsBrailleSpinner,
  containsQuarterCircleSpinner,
  containsAgentSpinnerGlyph
} from './agent-title-glyphs'
import { isDeepSeekBuildTerminalTitle } from './dsb-terminal-title'
import { isDshTerminalTitle } from './dsh-terminal-title'
export { DSH_WHALE, isDshTerminalTitle } from './dsh-terminal-title'
import { isQoderTerminalTitle } from './qoder-terminal-title'
import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAgentName,
  titleHasAnyLegacyAgentName
} from './agent-name-token-match'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { isLegacyPiCompatibleTitle } from './pi-compatible-synthetic-title'
import { memoizeTitleClassification } from './terminal-title-classification-memo'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'

export { AGY_AGENT_NAME_RE, DROID_AGENT_NAME_RE, HERMES_AGENT_NAME_RE, titleHasAgentName }

export type AgentStatus = 'working' | 'permission' | 'idle'

const CLAUDE_COMMAND_RE = String.raw`(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?`
export const CLAUDE_MANAGEMENT_TITLE_RE = new RegExp(
  String.raw`^\s*(?:"${CLAUDE_COMMAND_RE}"|'${CLAUDE_COMMAND_RE}'|${CLAUDE_COMMAND_RE})\s+agents\s*$`,
  'i'
)

const STRONG_IDLE_KEYWORDS = ['ready', 'idle', 'done'] as const
const STRONG_WORKING_KEYWORDS = ['working', 'thinking', 'running'] as const

// Reject path/hyphenated fragments; pre-16.4 Safari requires consuming boundaries whose captures global cleanup restores.
export const STRONG_IDLE_KEYWORDS_RE = new RegExp(
  `(^|[^\\w./\\\\-])(${STRONG_IDLE_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

// Match idle boundaries so reworking/is-thinking-cap cannot imply active work.
export const STRONG_WORKING_KEYWORDS_RE = new RegExp(
  `(^|[^\\w./\\\\-])(${STRONG_WORKING_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

export const STRONG_WORKING_KEYWORDS_RE_GLOBAL = new RegExp(STRONG_WORKING_KEYWORDS_RE.source, 'gi')

// Same boundaries so ~/x/permission, permission-check and awaiting are not prompts.
export const STRONG_PERMISSION_KEYWORDS_RE =
  /(^|[^\w./\\-])(action required|permission|waiting)(?![\w-])/i

export const CURSOR_NATIVE_TITLE_LOWER = 'cursor agent'

export function hasGeminiStatusGlyph(title: string): boolean {
  return (
    title.includes(GEMINI_PERMISSION) ||
    title.includes(GEMINI_WORKING) ||
    title.includes(GEMINI_SILENT_WORKING) ||
    title.includes(GEMINI_IDLE)
  )
}

function computeIsGeminiTerminalTitle(title: string): boolean {
  // Why: native Qoder and DSH markers own titles before the shared Gemini glyphs.
  if (isQoderTerminalTitle(title)) {
    return false
  }
  if (isDshTerminalTitle(title) || isDeepSeekBuildTerminalTitle(title)) {
    return false
  }
  // Why: Gemini OSC glyphs are stronger evidence than any cwd/session text.
  if (hasGeminiStatusGlyph(title)) {
    return true
  }
  // Pi/OMP cwd/session text may contain gemini-project; substrings cannot establish Gemini identity.
  if (isPiAgentTitle(title)) {
    return false
  }
  // agy model names contain Gemini tokens. Defer token identity when agy is present; real Gemini OSC glyphs remain decisive.
  if (titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)) {
    return false
  }
  return titleHasAgentName(title, 'gemini')
}

/** Pure in `title` — memoized so repeated selector reads skip the regex ladder. */
export const isGeminiTerminalTitle: (title: string) => boolean = memoizeTitleClassification(
  computeIsGeminiTerminalTitle
)

export function isPiTerminalTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title) && !containsBrailleSpinner(title)
}

export function isPiAgentTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title)
}

export function containsLegacyAgentName(title: string): boolean {
  return titleHasAnyLegacyAgentName(title)
}

export function containsAgentName(title: string): boolean {
  return (
    containsLegacyAgentName(title) ||
    AGY_AGENT_NAME_RE.test(title) ||
    DROID_AGENT_NAME_RE.test(title) ||
    HERMES_AGENT_NAME_RE.test(title)
  )
}

export function isClaudeManagementTitle(title: string): boolean {
  return CLAUDE_MANAGEMENT_TITLE_RE.test(title)
}

export function isCursorNativeAgentTitle(title: string): boolean {
  return title.trim().toLowerCase() === CURSOR_NATIVE_TITLE_LOWER
}

const CLAUDE_IDENTITY_FRAME_RE =
  /^claude(?: code)?(?:\s+(?:ready|idle|done|working|thinking|running))?(?:\s*-\s*action required)?$/

export function isClaudeIdentityFrameSegment(title: string): boolean {
  return CLAUDE_IDENTITY_FRAME_RE.test(
    stripLeadingAgentTitleDecorationOrEmpty(title).trim().toLowerCase()
  )
}

export function isClaudeIdentityFrameTitle(title: string): boolean {
  return getWrapperTitleSegments(title).some(isClaudeIdentityFrameSegment)
}

// Cursor is ordinary task vocabulary; match only its native literal and controlled hook-synthesized titles.
export function isCursorAgentTitle(title: string | null | undefined): boolean {
  if (typeof title !== 'string') {
    return false
  }
  const trimmed = title.trim()
  const lower = trimmed.toLowerCase()
  if (
    lower === CURSOR_NATIVE_TITLE_LOWER ||
    lower === 'cursor ready' ||
    lower === 'cursor - action required'
  ) {
    return true
  }
  // Only controlled synthetic Cursor spinner titles prove identity; display task text can mention Cursor.
  return /^[\u2800-\u28ff] Cursor Agent$/u.test(trimmed)
}

// Ignore bare Cursor redraws only after Cursor owns the title, preserving hook spinner state while still identifying hookless panes.
export function shouldSuppressCursorNativeTitle(lastEmittedTitle: string | null): boolean {
  return lastEmittedTitle !== null && isCursorAgentTitle(lastEmittedTitle)
}

// Collapse only Grok’s spinner - phrase - grok frame; both delimiters exclude Claude/Codex task mentions.
// Keep unspun session titles unchanged and accept spinner + grok so our collapsed label stays idempotent.
const GROK_ROTATING_FRAME_RE = /^[\u2800-\u28FF]+\s+-\s+[\s\S]+?\s-\s+grok\s*$/i
const GROK_COLLAPSED_WORKING_TITLE_RE = /^[\u2800-\u28FF]+\s+grok\s*$/i

export function isGrokRotatingWorkingTitle(title: string): boolean {
  if (!containsBrailleSpinner(title)) {
    return false
  }
  return GROK_ROTATING_FRAME_RE.test(title) || GROK_COLLAPSED_WORKING_TITLE_RE.test(title)
}
