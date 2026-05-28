// Why: xterm WebGL renders from a glyph atlas; actual complex text is safer
// through the browser text path. Terminal UI drawing glyphs stay on WebGL
// because xterm's custom-glyph renderer is built for those ranges.
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u

function isInRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end
}

function isRendererRiskCodePoint(value: number): boolean {
  return (
    isInRange(value, 0x0590, 0x08ff) ||
    value === 0x200d ||
    isInRange(value, 0x1100, 0x11ff) ||
    // Why: xterm WebGL can leave stale atlas cells for East Asian wide glyphs
    // on Windows; force browser text rendering before long CJK output paints.
    isInRange(value, 0x2e80, 0x9fff) ||
    isInRange(value, 0xa960, 0xa97f) ||
    isInRange(value, 0xac00, 0xd7ff) ||
    isInRange(value, 0xd800, 0xdfff) ||
    isInRange(value, 0xf900, 0xfaff) ||
    isInRange(value, 0xfe10, 0xfe1f) ||
    isInRange(value, 0xfe30, 0xfe4f) ||
    isInRange(value, 0xfb1d, 0xfdff) ||
    isInRange(value, 0xfe00, 0xfe0f) ||
    isInRange(value, 0xfe70, 0xfeff) ||
    isInRange(value, 0xff00, 0xffef) ||
    value === 0xfffd ||
    isInRange(value, 0x10ec0, 0x10eff) ||
    isInRange(value, 0x1e900, 0x1e95f) ||
    isInRange(value, 0x20000, 0x2fa1f) ||
    isInRange(value, 0x30000, 0x3134f) ||
    isInRange(value, 0xe0100, 0xe01ef)
  )
}

export function terminalOutputPrefersDomRenderer(data: string): boolean {
  let hasNonAscii = false
  for (let i = 0; i < data.length; i += 1) {
    if (data.charCodeAt(i) > 0x7f) {
      hasNonAscii = true
      break
    }
  }
  if (!hasNonAscii) {
    // Why: Codex-style terminal redraws are usually ASCII; avoid the Unicode
    // emoji/property regex and code-point walk on the hottest output path.
    return false
  }

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
