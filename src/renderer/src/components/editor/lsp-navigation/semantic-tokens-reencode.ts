// Re-encode decoded semantic tokens BY NAME to Monaco's relative 5-tuple
// Uint32Array (spike findings §1). The renderer looks up each token's type
// NAME against THIS legend (the same normalized set the client declared in
// initialize). Unknown names / skip sentinels are kept in the output at a
// NO_STYLING index instead of dropped: Monaco accumulates each tuple's delta
// against the PREVIOUS token, so omitting one shifts every later token's
// position (spike §1 follow-up — seen as keyword spans cut mid-identifier).
//
// The legend arrays mirror the client set in semantic-token-legend-decoder.ts
// (main process) so by-name matching is consistent end-to-end.
import {
  SEMANTIC_TOKEN_CLIENT_MODIFIERS,
  SEMANTIC_TOKEN_CLIENT_TYPES
} from '../../../../../shared/semantic-token-legend'
import type { LanguageServerSemanticToken } from '../../../../../shared/language-server-navigation-types'

export const SEMANTIC_TOKEN_RENDERER_TYPES: readonly string[] = SEMANTIC_TOKEN_CLIENT_TYPES
export const SEMANTIC_TOKEN_RENDERER_MODIFIERS: readonly string[] = SEMANTIC_TOKEN_CLIENT_MODIFIERS

function typeIndexFor(name: string): number {
  return SEMANTIC_TOKEN_RENDERER_TYPES.indexOf(name)
}

function modifierBitmaskFor(names: readonly string[]): number {
  let bits = 0
  for (const name of names) {
    const idx = SEMANTIC_TOKEN_RENDERER_MODIFIERS.indexOf(name)
    if (idx !== -1) {
      bits |= 1 << idx
    }
  }
  return bits
}

/**
 * Re-encodes the decoded tokens into Monaco's relative 5-tuple Uint32Array.
 * Each token contributes (deltaLine, deltaStartChar, length, typeIndex,
 * modifierBitmask). Tokens whose type name is unknown to the renderer legend
 * (or carries the skip sentinel) are kept in the output at a NO_STYLING index
 * instead of dropped — Monaco accumulates each tuple's delta against the
 * PREVIOUS tuple, so dropping one shifts every later token's position
 * (observed as keyword spans cut mid-identifier on C/C++ files).
 *
 * `SEMANTIC_TOKEN_RENDERER_TYPES.length` is out-of-range for the legend;
 * Monaco maps an undefined `tokenTypes[index]` to NO_STYLING and falls back to
 * the lexical (Monarch) layer, matching the old drop intent without breaking
 * delta order.
 *
 * Pure + monaco-free so it stays unit-testable in isolation.
 */
export function reencodeSemanticTokensForMonaco(
  tokens: readonly LanguageServerSemanticToken[]
): Uint32Array {
  const tuples: number[] = []
  // Out-of-range index: Monaco's styling resolves `tokenTypes[index]` to
  // undefined -> NO_STYLING -> lexical color, while preserving delta order.
  const noStylingTypeIndex = SEMANTIC_TOKEN_RENDERER_TYPES.length
  for (const token of tokens) {
    const typeIndex = token.skip ? -1 : typeIndexFor(token.type)
    if (typeIndex < 0) {
      // Unknown name / skip sentinel — keep the delta so later tokens stay
      // aligned, but mark NO_STYLING (Monaco decodes an out-of-range index as
      // 'not-in-legend' and skips coloring).
      tuples.push(token.line, token.char, token.length, noStylingTypeIndex, 0)
      continue
    }
    tuples.push(
      token.line,
      token.char,
      token.length,
      typeIndex,
      modifierBitmaskFor(token.modifiers)
    )
  }
  return new Uint32Array(tuples)
}
