// Why: xterm WebGL renders from a glyph atlas; agent TUIs often combine glyphs
// that are safer through the browser text path even when they are not RTL.
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u

function isInRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end
}

function isRendererRiskCodePoint(value: number): boolean {
  return (
    isInRange(value, 0x0590, 0x08ff) ||
    value === 0x200d ||
    isInRange(value, 0x2500, 0x259f) ||
    isInRange(value, 0x25a0, 0x25ff) ||
    isInRange(value, 0x2800, 0x28ff) ||
    isInRange(value, 0xd800, 0xdfff) ||
    isInRange(value, 0xe000, 0xf8ff) ||
    isInRange(value, 0xfb1d, 0xfdff) ||
    isInRange(value, 0xfe00, 0xfe0f) ||
    isInRange(value, 0xfe70, 0xfeff) ||
    value === 0xfffd ||
    isInRange(value, 0x10ec0, 0x10eff) ||
    isInRange(value, 0x1e900, 0x1e95f) ||
    isInRange(value, 0xe0100, 0xe01ef)
  )
}

export function terminalOutputPrefersDomRenderer(data: string): boolean {
  if (EMOJI_PRESENTATION_PATTERN.test(data)) {
    return true
  }
  for (let i = 0; i < data.length; i += 1) {
    const codePoint = data.codePointAt(i)
    if (codePoint === undefined) {
      continue
    }
    if (isRendererRiskCodePoint(codePoint)) {
      return true
    }
    if (codePoint > 0xffff) {
      i += 1
    }
  }
  return false
}
