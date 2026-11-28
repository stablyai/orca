import {
  GEMINI_WORKING,
  GEMINI_SILENT_WORKING,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  containsBrailleSpinner
} from './agent-title-glyphs'

import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAnyLegacyAgentName
} from './agent-name-token-match'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { isLegacyPiCompatibleTitle } from './providers/pi-compatible-synthetic-title'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'

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

const GEMINI_GLYPH_CLASS = `[${GEMINI_PERMISSION}${GEMINI_WORKING}${GEMINI_SILENT_WORKING}${GEMINI_IDLE}]`
// Gemini-family titles (Qoder's idle frame among them) open with the glyph, or a `<glyph>  ` frame behind a tmux/Administrator prefix; leftmost anchor wins.
const GEMINI_STATUS_GLYPH_RE = new RegExp(
  String.raw`(?:^\s*| \| \s*|["'\s](?=${GEMINI_GLYPH_CLASS}  ))(${GEMINI_GLYPH_CLASS})`
)

export function leadingGeminiGlyphStatus(title: string): AgentStatus | null {
  const glyph = GEMINI_STATUS_GLYPH_RE.exec(title)?.[1]
  if (!glyph) {
    return null
  }
  if (glyph === GEMINI_PERMISSION) {
    return 'permission'
  }
  return glyph === GEMINI_IDLE ? 'idle' : 'working'
}

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

// Grok frames read `[⚠ Action required - ]<spinner> - <activity> - [<session> - ]grok`; Windows uses `!` and spins | / - \.
// Both delimiters exclude Claude/Codex task mentions; our exact collapsed labels match too so they stay idempotent and keep identity.
const GROK_FRAME_RE =
  /^(?<actionRequired>[!\u26a0] Action required\s+-\s+)?(?:[\u2800-\u28FF]+|[|/\\-])\s+-\s+[\s\S]+?\s-\s+grok\s*$/i
export const GROK_WORKING_TITLE = '\u280b Grok'
export const GROK_PERMISSION_TITLE = 'Grok - action required'

export function grokFrameTitleStatus(title: string): 'working' | 'permission' | null {
  const frame = GROK_FRAME_RE.exec(title)
  if (frame) {
    return frame.groups?.actionRequired ? 'permission' : 'working'
  }
  return title === GROK_PERMISSION_TITLE
    ? 'permission'
    : title === GROK_WORKING_TITLE
      ? 'working'
      : null
}
