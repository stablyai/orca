export const CLAUDE_IDLE = '\u2733'
export const GEMINI_WORKING = '\u2726' // ✦
export const GEMINI_SILENT_WORKING = '\u23f2' // ⏲
export const GEMINI_IDLE = '\u25c7' // ◇
export const GEMINI_PERMISSION = '\u270b' // ✋

export const BRAILLE_SPINNER_RE = /[\u2800-\u28ff]/g

// Reserve the quarter-circle block: Claude 2.1.228 replaced braille with it, which once looked like an agent exit (#13889).
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

/** Generic animated activity only; agent-specific Grok/Pi/synthetic Cursor frames retain their own sets. */
export function containsAgentSpinnerGlyph(title: string): boolean {
  return containsBrailleSpinner(title) || containsQuarterCircleSpinner(title)
}
