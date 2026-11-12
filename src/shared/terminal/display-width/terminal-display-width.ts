// East_Asian_Width Wide/Fullwidth blocks (Hangul, CJK, kana, Tangut, fullwidth forms) plus emoji
// except regional indicators (each flag half is one cell). U+3248-324F are Ambiguous, so one cell.
const WIDE_CODE_POINT =
  /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3041-\u3247\u3250-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{18aff}\u{1b000}-\u{1b2ff}\u{1f200}-\u{1f265}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]|(?![\u{1f1e6}-\u{1f1ff}])\p{Emoji_Presentation}/u
// Conjoining Hangul vowel/final jamo draw inside the leading jamo's cell; xterm still draws U+00AD.
const ZERO_WIDTH_CODE_POINT = /(?!\u00ad)[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff]/u
const ZERO_WIDTH_JOINER = '\u200d'

// Why: approximates Orca's xterm Unicode11 provider (terminal-unicode-provider.ts) by summing per code
// point, where skin-tone modifiers advance and only ZWJ joins glyphs. Post-Unicode-11 emoji stay 2 wide.
function terminalDisplayWidth(text: string): number {
  let width = 0
  let joinsNext = false
  for (const codePoint of text) {
    if (codePoint === ZERO_WIDTH_JOINER) {
      joinsNext = width > 0
    } else if (!ZERO_WIDTH_CODE_POINT.test(codePoint)) {
      width += joinsNext ? 0 : WIDE_CODE_POINT.test(codePoint) ? 2 : 1
      joinsNext = false
    }
  }
  return width
}

/** `padEnd` by terminal columns: wide CJK/Hangul cells count as two, combining marks as zero. */
export function padEndToTerminalWidth(text: string, columns: number): string {
  const padding = columns - terminalDisplayWidth(text)
  return padding > 0 ? text + ' '.repeat(padding) : text
}
