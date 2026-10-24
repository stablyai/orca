// Emoji code-point ranges that decide how many terminal cells a grapheme
// cluster occupies. Consumed only by terminal-unicode-provider.ts, which is the
// single width authority every Orca terminal (renderer pane, headless daemon
// mirror, dashboard preview, restore-parity fixture) activates.
//
// WHY THE TABLES ARE FROZEN HERE rather than read from the runtime's Unicode
// data: this width is a cross-host contract. A pane's cells are laid out by
// whichever host runs the terminal and re-derived by whichever client renders
// it, and Electron's V8, plain Node and the mobile JSC ship different ICU
// versions. Deriving at runtime would make two Orca processes disagree about
// the same buffer purely because they embed different Unicode data — the exact
// failure this module exists to remove. Freezing the table moves the version
// skew to something a release controls.
//
// WHY NOT xterm's grapheme-clustering provider: it is upstream-experimental,
// leaves every post-Unicode-11 emoji below at one cell, and disagrees with
// other terminals on ZWJ-plus-variation clusters. It does not answer the
// measurement this module exists to fix.
//
// The tables are DERIVED, not hand-written, and
// terminal-emoji-width-ranges.derivation.test.ts re-derives all three from the
// runtime's Unicode data on every run so they cannot go stale the way xterm's
// Unicode 11 table did:
//   WIDE   = \p{Emoji_Presentation} where xterm's v11 wcwidth is not 2,
//            minus regional indicators U+1F1E6..U+1F1FF (see below).
//   VSBASE = \p{Emoji} without \p{Emoji_Presentation} whose v11 wcwidth is 1,
//            i.e. the bases a following U+FE0F promotes to emoji presentation.
//   MODBASE= \p{Emoji_Modifier_Base}, i.e. the bases a skin-tone modifier may
//            attach to.
// Generated against Unicode 17.0.
//
// Regional indicators are excluded on purpose: xterm has no grapheme
// segmentation, so a flag reaches two cells as 1 + 1. Widening each indicator
// would make a flag four cells wide.

/** Sorted, non-overlapping, ascending. */
export type CodepointRange = readonly [number, number]

export const EMOJI_PRESENTATION_WIDE_RANGES: readonly CodepointRange[] = [
  [0x1f6d6, 0x1f6d8],
  [0x1f6dc, 0x1f6df],
  [0x1f6fb, 0x1f6fc],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f90c],
  [0x1f972, 0x1f972],
  [0x1f977, 0x1f979],
  [0x1f9a3, 0x1f9a4],
  [0x1f9ab, 0x1f9ad],
  [0x1f9cb, 0x1f9cc],
  [0x1fa74, 0x1fa77],
  [0x1fa7b, 0x1fa7c],
  [0x1fa83, 0x1fa8a],
  [0x1fa8e, 0x1fa8f],
  [0x1fa96, 0x1fac6],
  [0x1fac8, 0x1fac8],
  [0x1facd, 0x1fadc],
  [0x1fadf, 0x1faea],
  [0x1faef, 0x1faf8]
]

export const EMOJI_VARIATION_BASE_RANGES: readonly CodepointRange[] = [
  [0x23, 0x23],
  [0x2a, 0x2a],
  [0x30, 0x39],
  [0xa9, 0xa9],
  [0xae, 0xae],
  [0x203c, 0x203c],
  [0x2049, 0x2049],
  [0x2122, 0x2122],
  [0x2139, 0x2139],
  [0x2194, 0x2199],
  [0x21a9, 0x21aa],
  [0x2328, 0x2328],
  [0x23cf, 0x23cf],
  [0x23ed, 0x23ef],
  [0x23f1, 0x23f2],
  [0x23f8, 0x23fa],
  [0x24c2, 0x24c2],
  [0x25aa, 0x25ab],
  [0x25b6, 0x25b6],
  [0x25c0, 0x25c0],
  [0x25fb, 0x25fc],
  [0x2600, 0x2604],
  [0x260e, 0x260e],
  [0x2611, 0x2611],
  [0x2618, 0x2618],
  [0x261d, 0x261d],
  [0x2620, 0x2620],
  [0x2622, 0x2623],
  [0x2626, 0x2626],
  [0x262a, 0x262a],
  [0x262e, 0x262f],
  [0x2638, 0x263a],
  [0x2640, 0x2640],
  [0x2642, 0x2642],
  [0x265f, 0x2660],
  [0x2663, 0x2663],
  [0x2665, 0x2666],
  [0x2668, 0x2668],
  [0x267b, 0x267b],
  [0x267e, 0x267e],
  [0x2692, 0x2692],
  [0x2694, 0x2697],
  [0x2699, 0x2699],
  [0x269b, 0x269c],
  [0x26a0, 0x26a0],
  [0x26a7, 0x26a7],
  [0x26b0, 0x26b1],
  [0x26c8, 0x26c8],
  [0x26cf, 0x26cf],
  [0x26d1, 0x26d1],
  [0x26d3, 0x26d3],
  [0x26e9, 0x26e9],
  [0x26f0, 0x26f1],
  [0x26f4, 0x26f4],
  [0x26f7, 0x26f9],
  [0x2702, 0x2702],
  [0x2708, 0x2709],
  [0x270c, 0x270d],
  [0x270f, 0x270f],
  [0x2712, 0x2712],
  [0x2714, 0x2714],
  [0x2716, 0x2716],
  [0x271d, 0x271d],
  [0x2721, 0x2721],
  [0x2733, 0x2734],
  [0x2744, 0x2744],
  [0x2747, 0x2747],
  [0x2763, 0x2764],
  [0x27a1, 0x27a1],
  [0x2934, 0x2935],
  [0x2b05, 0x2b07],
  [0x1f170, 0x1f171],
  [0x1f17e, 0x1f17f],
  [0x1f321, 0x1f321],
  [0x1f324, 0x1f32c],
  [0x1f336, 0x1f336],
  [0x1f37d, 0x1f37d],
  [0x1f396, 0x1f397],
  [0x1f399, 0x1f39b],
  [0x1f39e, 0x1f39f],
  [0x1f3cb, 0x1f3ce],
  [0x1f3d4, 0x1f3df],
  [0x1f3f3, 0x1f3f3],
  [0x1f3f5, 0x1f3f5],
  [0x1f3f7, 0x1f3f7],
  [0x1f43f, 0x1f43f],
  [0x1f441, 0x1f441],
  [0x1f4fd, 0x1f4fd],
  [0x1f549, 0x1f54a],
  [0x1f56f, 0x1f570],
  [0x1f573, 0x1f579],
  [0x1f587, 0x1f587],
  [0x1f58a, 0x1f58d],
  [0x1f590, 0x1f590],
  [0x1f5a5, 0x1f5a5],
  [0x1f5a8, 0x1f5a8],
  [0x1f5b1, 0x1f5b2],
  [0x1f5bc, 0x1f5bc],
  [0x1f5c2, 0x1f5c4],
  [0x1f5d1, 0x1f5d3],
  [0x1f5dc, 0x1f5de],
  [0x1f5e1, 0x1f5e1],
  [0x1f5e3, 0x1f5e3],
  [0x1f5e8, 0x1f5e8],
  [0x1f5ef, 0x1f5ef],
  [0x1f5f3, 0x1f5f3],
  [0x1f5fa, 0x1f5fa],
  [0x1f6cb, 0x1f6cb],
  [0x1f6cd, 0x1f6cf],
  [0x1f6e0, 0x1f6e5],
  [0x1f6e9, 0x1f6e9],
  [0x1f6f0, 0x1f6f0],
  [0x1f6f3, 0x1f6f3]
]

export const EMOJI_MODIFIER_BASE_RANGES: readonly CodepointRange[] = [
  [0x261d, 0x261d],
  [0x26f9, 0x26f9],
  [0x270a, 0x270d],
  [0x1f385, 0x1f385],
  [0x1f3c2, 0x1f3c4],
  [0x1f3c7, 0x1f3c7],
  [0x1f3ca, 0x1f3cc],
  [0x1f442, 0x1f443],
  [0x1f446, 0x1f450],
  [0x1f466, 0x1f478],
  [0x1f47c, 0x1f47c],
  [0x1f481, 0x1f483],
  [0x1f485, 0x1f487],
  [0x1f48f, 0x1f48f],
  [0x1f491, 0x1f491],
  [0x1f4aa, 0x1f4aa],
  [0x1f574, 0x1f575],
  [0x1f57a, 0x1f57a],
  [0x1f590, 0x1f590],
  [0x1f595, 0x1f596],
  [0x1f645, 0x1f647],
  [0x1f64b, 0x1f64f],
  [0x1f6a3, 0x1f6a3],
  [0x1f6b4, 0x1f6b6],
  [0x1f6c0, 0x1f6c0],
  [0x1f6cc, 0x1f6cc],
  [0x1f90c, 0x1f90c],
  [0x1f90f, 0x1f90f],
  [0x1f918, 0x1f91f],
  [0x1f926, 0x1f926],
  [0x1f930, 0x1f939],
  [0x1f93c, 0x1f93e],
  [0x1f977, 0x1f977],
  [0x1f9b5, 0x1f9b6],
  [0x1f9b8, 0x1f9b9],
  [0x1f9bb, 0x1f9bb],
  [0x1f9cd, 0x1f9cf],
  [0x1f9d1, 0x1f9dd],
  [0x1fac3, 0x1fac5],
  [0x1faf0, 0x1faf8]
]

/** Lowest code point in EMOJI_PRESENTATION_WIDE_RANGES; skips the table for ASCII and CJK. */
const EMOJI_PRESENTATION_WIDE_FIRST = 0x1f6d6

const EMOJI_MODIFIER_FIRST = 0x1f3fb
const EMOJI_MODIFIER_LAST = 0x1f3ff

function inRanges(ranges: readonly CodepointRange[], codepoint: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid]!
    if (codepoint < range[0]) {
      high = mid - 1
    } else if (codepoint > range[1]) {
      low = mid + 1
    } else {
      return true
    }
  }
  return false
}

/** Emoji that default to emoji presentation but postdate xterm's frozen Unicode 11 width table. */
export function isEmojiPresentationWideCodepoint(codepoint: number): boolean {
  return (
    codepoint >= EMOJI_PRESENTATION_WIDE_FIRST &&
    inRanges(EMOJI_PRESENTATION_WIDE_RANGES, codepoint)
  )
}

/** A code point U+FE0F may promote to emoji presentation, per emoji-variation-sequences. */
export function isEmojiVariationSequenceBase(codepoint: number): boolean {
  return inRanges(EMOJI_VARIATION_BASE_RANGES, codepoint)
}

/** Skin-tone modifiers U+1F3FB..U+1F3FF. */
export function isEmojiModifier(codepoint: number): boolean {
  return codepoint >= EMOJI_MODIFIER_FIRST && codepoint <= EMOJI_MODIFIER_LAST
}

/** A code point a skin-tone modifier may attach to. */
export function isEmojiModifierBase(codepoint: number): boolean {
  return inRanges(EMOJI_MODIFIER_BASE_RANGES, codepoint)
}
