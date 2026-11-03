import type { CSSProperties } from 'react'

// Why: Chromium reshapes a kerned run with no break opportunity at every wrap, quadratic in its
// length (1 MiB of "x": 19 s); past this length kerning goes, which keeps 1 MiB of such runs near 0.2 s.
const KERNED_RUN_MAX_CHARS = 256

export const NATIVE_CHAT_UNKERNED_STYLE = 'font-kerning: none'
export const NATIVE_CHAT_UNKERNED_CSS: CSSProperties = { fontKerning: 'none' }

// Whitespace, plus scripts Chromium breaks between characters: Thai, Hangul, kana, CJK ideographs.
export function nativeChatBreaksUnkernedRun(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    (code >= 0x0e00 && code <= 0x0e7f) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    // High surrogates of the supplementary ideograph planes (U+20000-U+3FFFF).
    (code >= 0xd840 && code <= 0xd8bf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

export const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
export const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** `[start, end)` of every run with no break opportunity too long to lay out kerned; one linear pass. */
export function nativeChatUnkernedRuns(text: string, limit = Infinity): [number, number][] {
  const runs: [number, number][] = []
  let start = 0
  for (let index = 0; index <= text.length && runs.length < limit; index++) {
    const code = text.charCodeAt(index)
    if (index === text.length || nativeChatBreaksUnkernedRun(code)) {
      if (index - start > KERNED_RUN_MAX_CHARS) {
        runs.push([start, index])
      }
      // A supplementary ideograph breaks as one code point, both surrogates.
      const width = isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1)) ? 2 : 1
      start = index + width
      index += width - 1
    }
  }
  return runs
}

export function nativeChatTextHasUnkernedRun(text: string): boolean {
  return nativeChatUnkernedRuns(text, 1).length > 0
}
