import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAgentName,
  titleHasAnyLegacyAgentName
} from './agent-name-token-match'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { isLegacyPiCompatibleTitle } from './pi-compatible-synthetic-title'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'

export { AGY_AGENT_NAME_RE, DROID_AGENT_NAME_RE, HERMES_AGENT_NAME_RE, titleHasAgentName }

export type AgentStatus = 'working' | 'permission' | 'idle'

export const CLAUDE_IDLE = '\u2733' // ✳
const CLAUDE_COMMAND_RE = String.raw`(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?`
export const CLAUDE_MANAGEMENT_TITLE_RE = new RegExp(
  String.raw`^\s*(?:"${CLAUDE_COMMAND_RE}"|'${CLAUDE_COMMAND_RE}'|${CLAUDE_COMMAND_RE})\s+agents\s*$`,
  'i'
)

export const GEMINI_WORKING = '\u2726' // ✦
export const GEMINI_SILENT_WORKING = '\u23f2' // ⏲
export const GEMINI_IDLE = '\u25c7' // ◇
export const GEMINI_PERMISSION = '\u270b' // ✋

const STRONG_IDLE_KEYWORDS = ['ready', 'idle', 'done'] as const
const STRONG_WORKING_KEYWORDS = ['working', 'thinking', 'running'] as const

// Why: plain `\b` matches inside hyphenated tokens and cwd paths such as
// "~/codex/ready"; the left side also blocks path separators for Windows/Unix.
export const STRONG_IDLE_KEYWORDS_RE = new RegExp(
  `(?<![\\w./\\\\-])(${STRONG_IDLE_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

// Why: mirrors the idle matcher so titles like "reworking" or
// "is-thinking-cap" do not drive false active-agent UI.
export const STRONG_WORKING_KEYWORDS_RE = new RegExp(
  `(?<![\\w./\\\\-])(${STRONG_WORKING_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

export const STRONG_WORKING_KEYWORDS_RE_GLOBAL = new RegExp(STRONG_WORKING_KEYWORDS_RE.source, 'gi')

export const CURSOR_NATIVE_TITLE_LOWER = 'cursor agent'

// eslint-disable-next-line no-control-regex -- intentional unicode range
export const BRAILLE_SPINNER_RE = /[\u2800-\u28ff]/g

// Why: Claude Code 2.1.228 swapped its busy title spinner from braille to
// quarter circles (#13889), which read as "no agent" and looked like an exit.
// Reserve the whole quarter-circle block so a later frame addition cannot regress this.
export const QUARTER_CIRCLE_SPINNER_RE = /[\u25d0-\u25d3]/g

export function isGeminiTerminalTitle(title: string): boolean {
  // Why: Gemini OSC glyphs are stronger evidence than any cwd/session text.
  if (
    title.includes(GEMINI_PERMISSION) ||
    title.includes(GEMINI_WORKING) ||
    title.includes(GEMINI_SILENT_WORKING) ||
    title.includes(GEMINI_IDLE)
  ) {
    return true
  }
  // Why: Pi/OMP titles include cwd/session text; substring matching made
  // paths like "gemini-project" masquerade as Gemini CLI.
  if (isPiAgentTitle(title)) {
    return false
  }
  // Why: Antigravity's models are named "Gemini <n.n> <Name>", so an agy pane's own
  // title carries a whole `gemini` token. Gemini CLI is checked before Antigravity in
  // getAgentLabel, so without this the model name wins and an agy pane reads as Gemini
  // CLI. Only the token path defers — the four Gemini OSC glyphs stay decisive, and agy
  // emits none of them.
  if (titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)) {
    return false
  }
  return titleHasAgentName(title, 'gemini')
}

export function isPiTerminalTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title) && !containsBrailleSpinner(title)
}

export function isPiAgentTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title)
}

export function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) {
      return true
    }
  }
  return false
}

export function containsQuarterCircleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x25d0 && codePoint <= 0x25d3) {
      return true
    }
  }
  return false
}

/**
 * Any spinner frame glyph an agent animates its OSC title with. Use this for
 * generic "something is running" checks; agent-specific frame shapes (Grok,
 * Pi, synthetic Cursor) stay pinned to their own glyph set.
 */
export function containsAgentSpinnerGlyph(title: string): boolean {
  return containsBrailleSpinner(title) || containsQuarterCircleSpinner(title)
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

export function containsAny(title: string, words: readonly string[]): boolean {
  const lower = title.toLowerCase()
  return words.some((word) => lower.includes(word))
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

// Why: `cursor` is also an ordinary editor noun that other agents type into their own
// task-summary titles, so a name token is not identity. Cursor's identifying titles are
// a closed set (the native literal plus the labels Orca synthesizes from Cursor hooks),
// so match that vocabulary instead.
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
  // Why: display labels can mention Cursor in another agent's task text. Only
  // treat the controlled synthetic Cursor spinner title as Cursor identity.
  return /^[\u2800-\u28ff] Cursor Agent$/u.test(trimmed)
}

// Why: cursor-agent re-emits its bare native title every redraw, which would stomp
// Orca's hook-synthesized spinner state, but only once a Cursor-owned title already
// owns the pane. A hookless Cursor pane still needs the literal once, for identity.
export function shouldSuppressCursorNativeTitle(lastEmittedTitle: string | null): boolean {
  return lastEmittedTitle !== null && isCursorAgentTitle(lastEmittedTitle)
}
