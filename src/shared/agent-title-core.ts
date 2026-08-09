import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAgentName,
  titleHasAnyLegacyAgentName
} from './agent-name-token-match'
import { isLegacyPiCompatibleTitle } from './pi-compatible-synthetic-title'

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

// qodercli's OSC title label, and the glyph it uses for awaiting-confirmation. It forked gemini-cli
// and kept ✦/◇, so glyph checks alone hand its panes to Gemini; ▲ replaces Gemini's ✋.
export const QODERCLI_LABEL = 'Qoder CLI'
export const QODERCLI_PERMISSION = '\u25b2' // ▲

// Why: two structural differences separate qodercli from Gemini, and BOTH are needed.
//   qodercli: "<glyph> <session title> | <status>" — ONE space, trailing " | status"
//   Gemini:   "<glyph>  <Status> (context)"        — TWO spaces, parenthesized context, no pipe
// The one-space lookahead is what rejects a raw upstream Gemini status containing " | " (e.g.
// "✦  Running ls | grep foo (repo)"). Status words are deliberately not matched: qodercli changed
// that vocabulary twice in three weeks, so Orca must key on shape, not wording.
const QODERCLI_DYNAMIC_TITLE_RE = /^[\u2726\u25c7\u25b2] (?! ).*\s\|\s[^|]+$/
// Why: the non-dynamic form, `Qoder CLI (<session title>)`.
const QODERCLI_STATIC_TITLE_RE = /^Qoder CLI(?: CN)? \(/
// Why: normalizeTerminalTitle collapses qodercli frames to "<glyph> Qoder CLI", which carries
// neither a pipe nor parens. Without this the collapsed label falls straight back to Gemini on the
// next read — the same trap GROK_COLLAPSED_WORKING_TITLE_RE exists to avoid.
// Why the glyph is optional: clearWorkingIndicators strips ✦ from stale exit titles, leaving a bare
// "Qoder CLI". Gemini's equivalent survives that via titleHasAgentName(…, 'gemini'); without this
// qodercli would lose its identity where Gemini keeps it. Anchored, so it must be the whole title —
// the same bet the repo already takes for 'MiMo Code'.
const QODERCLI_COLLAPSED_TITLE_RE = /^(?:[\u2726\u25c7\u25b2] )?Qoder CLI(?: CN)?$/

export function isQoderCliTerminalTitle(title: string): boolean {
  // Why: qodercli pads its OSC title to 80 chars, so " | status" is not at end-of-string.
  const trimmed = title.trimEnd()
  return (
    QODERCLI_STATIC_TITLE_RE.test(trimmed) ||
    QODERCLI_COLLAPSED_TITLE_RE.test(trimmed) ||
    QODERCLI_DYNAMIC_TITLE_RE.test(trimmed)
  )
}

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

export function isGeminiTerminalTitle(title: string): boolean {
  // Why: qodercli forked gemini-cli and reuses its status glyphs, so its own title shape must be
  // ruled out before the glyph test below claims the pane.
  if (isQoderCliTerminalTitle(title)) {
    return false
  }
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
