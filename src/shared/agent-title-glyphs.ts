export const CLAUDE_IDLE = '\u2733' // ✳
export const GEMINI_WORKING = '\u2726' // ✦
export const GEMINI_SILENT_WORKING = '\u23f2' // ⏲
export const GEMINI_IDLE = '\u25c7' // ◇
export const GEMINI_PERMISSION = '\u270b' // ✋

// eslint-disable-next-line no-control-regex -- intentional unicode range
export const BRAILLE_SPINNER_RE = /[\u2800-\u28ff]/g

// Why: Claude Code 2.1.228 swapped its busy title spinner from braille to
// quarter circles (#13889), which read as "no agent" and looked like an exit.
// Reserve the whole quarter-circle block so a later frame addition cannot regress this.
export const QUARTER_CIRCLE_SPINNER_RE = /[\u25d0-\u25d3]/g

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
