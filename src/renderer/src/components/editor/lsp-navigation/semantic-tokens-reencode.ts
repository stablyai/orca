// Re-encode decoded semantic tokens BY NAME to Monaco's relative 5-tuple
// Uint32Array (spike findings §1). The renderer looks up each token's type NAME
// against THIS legend (the same normalized set the client declared in
// initialize) — unknown names are SKIPPED so the Monarch lexical layer colors
// the identifier (clangd self-invented types like `unknown`/`bracket`/`label`
// are not claimed). The modifiers bitmask is built the same way by name.
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
 * Each kept token contributes (deltaLine, deltaStartChar, length, typeIndex,
 * modifierBitmask). Tokens whose type name is unknown to the renderer legend
 * (or carries the skip sentinel) are dropped — the lexical layer colors them.
 *
 * Pure + monaco-free so it stays unit-testable in isolation.
 */
export function reencodeSemanticTokensForMonaco(
  tokens: readonly LanguageServerSemanticToken[]
): Uint32Array {
  const tuples: number[] = []
  for (const token of tokens) {
    if (token.skip) {
      continue
    }
    const typeIndex = typeIndexFor(token.type)
    if (typeIndex < 0) {
      // Unknown name (clangd self-invented type not in the client legend) —
      // skip so the Monarch lexical layer colors this identifier.
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
