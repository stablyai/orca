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
