import { describe, expect, it } from 'vitest'
import {
  SEMANTIC_TOKEN_RENDERER_TYPES,
  SEMANTIC_TOKEN_RENDERER_MODIFIERS,
  reencodeSemanticTokensForMonaco
} from './semantic-tokens-reencode'
import type { LanguageServerSemanticToken } from '../../../../../shared/language-server-navigation-types'

function typeIndex(name: string): number {
  return SEMANTIC_TOKEN_RENDERER_TYPES.indexOf(name)
}

function modBitmask(names: string[]): number {
  let bits = 0
  for (const name of names) {
    const idx = SEMANTIC_TOKEN_RENDERER_MODIFIERS.indexOf(name)
    if (idx !== -1) {
      bits |= 1 << idx
    }
  }
  return bits
}

describe('reencodeSemanticTokensForMonaco', () => {
  it('re-encodes decoded tokens BY NAME against the renderer legend into Monaco relative 5-tuples', () => {
    // clangd's legend differs from the renderer's; the server's `function` and
    // `variable` names map to the renderer legend indices by NAME (spike §1).
    const tokens: LanguageServerSemanticToken[] = [
      { line: 0, char: 0, length: 4, type: 'function', modifiers: ['declaration', 'definition'] },
      { line: 0, char: 8, length: 5, type: 'variable', modifiers: ['globalScope'] },
      { line: 2, char: 0, length: 7, type: 'type', modifiers: [] }
    ]

    const data = reencodeSemanticTokensForMonaco(tokens)

    // Monaco's interface data encoding IS the LSP relative 5-tuple — 5 entries
    // per token, no 0/1-based conversion (spike findings §1).
    expect(data).toBeInstanceOf(Uint32Array)
    expect(Array.from(data)).toEqual([
      0,
      0,
      4,
      typeIndex('function'),
      modBitmask(['declaration', 'definition']),
      0,
      8,
      5,
      typeIndex('variable'),
      modBitmask(['globalScope']),
      2,
      0,
      7,
      typeIndex('type'),
      0
    ])
  })

  it('keeps unknown-name tokens at a NO_STYLING index so later deltas stay aligned', () => {
    // clangd self-invented names like 'unknown'/'bracket'/'label' are NOT in
    // the renderer legend. Dropping them would shift later tokens' relative
    // deltas (Monaco accumulates each tuple against the previous one), so they
    // are kept at a NO_STYLING (out-of-range) index — Monaco resolves an
    // undefined legend entry to NO_STYLING and the lexical layer colors them.
    const noStylingIndex = SEMANTIC_TOKEN_RENDERER_TYPES.length
    const tokens: LanguageServerSemanticToken[] = [
      { line: 0, char: 0, length: 3, type: 'function', modifiers: [] },
      { line: 0, char: 4, length: 1, type: 'bracket', modifiers: [] },
      { line: 0, char: 6, length: 5, type: 'label', modifiers: [] },
      { line: 1, char: 0, length: 7, type: 'variable', modifiers: [] }
    ]

    const data = reencodeSemanticTokensForMonaco(tokens)

    // The unknown tokens keep their deltas with a NO_STYLING index, so the
    // 'variable' (1,0) delta stays relative to the 'label' token as clangd
    // encoded it — not relative to 'function', which would misplace it.
    expect(Array.from(data)).toEqual([
      0,
      0,
      3,
      typeIndex('function'),
      0,
      0,
      4,
      1,
      noStylingIndex,
      0,
      0,
      6,
      5,
      noStylingIndex,
      0,
      1,
      0,
      7,
      typeIndex('variable'),
      0
    ])
  })

  it('keeps skip-sentinel tokens at a NO_STYLING index so delta order is preserved', () => {
    const noStylingIndex = SEMANTIC_TOKEN_RENDERER_TYPES.length
    const tokens: LanguageServerSemanticToken[] = [
      { line: 0, char: 0, length: 3, type: 'macro', modifiers: [] },
      { line: 0, char: 4, length: 2, type: '', modifiers: [], skip: true },
      { line: 0, char: 7, length: 4, type: 'variable', modifiers: [] }
    ]

    const data = reencodeSemanticTokensForMonaco(tokens)

    // The skip token keeps its delta so 'variable' (0,7) stays relative to the
    // skip token (as the server encoded it), not relative to 'macro'.
    expect(Array.from(data)).toEqual([
      0,
      0,
      3,
      typeIndex('macro'),
      0,
      0,
      4,
      2,
      noStylingIndex,
      0,
      0,
      7,
      4,
      typeIndex('variable'),
      0
    ])
  })

  it('returns an empty Uint32Array for no tokens', () => {
    expect(Array.from(reencodeSemanticTokensForMonaco([]))).toEqual([])
  })
})

describe('SEMANTIC_TOKEN_RENDERER_TYPES', () => {
  it('declares the ≥5 identifier classes the acceptance criteria color', () => {
    expect(SEMANTIC_TOKEN_RENDERER_TYPES).toEqual(
      expect.arrayContaining(['function', 'type', 'variable', 'macro', 'enumMember'])
    )
    expect(SEMANTIC_TOKEN_RENDERER_TYPES.length).toBeGreaterThanOrEqual(5)
  })
})
