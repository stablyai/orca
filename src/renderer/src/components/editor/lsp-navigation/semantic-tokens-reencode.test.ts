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

  it('skips tokens whose type name is unknown to the renderer legend (lexical color preserved)', () => {
    // clangd self-invented names like 'unknown'/'bracket'/'label' are NOT in the
    // renderer legend — they are dropped so the Monarch lexical layer colors them.
    const tokens: LanguageServerSemanticToken[] = [
      { line: 0, char: 0, length: 3, type: 'function', modifiers: [] },
      { line: 0, char: 4, length: 1, type: 'bracket', modifiers: [] },
      { line: 0, char: 6, length: 5, type: 'label', modifiers: [] },
      { line: 1, char: 0, length: 7, type: 'variable', modifiers: [] }
    ]

    const data = reencodeSemanticTokensForMonaco(tokens)

    expect(Array.from(data)).toEqual([
      0,
      0,
      3,
      typeIndex('function'),
      0,
      1,
      0,
      7,
      typeIndex('variable'),
      0
    ])
  })

  it('skips the explicit skip-sentinel tokens (out-of-range server indices)', () => {
    const tokens: LanguageServerSemanticToken[] = [
      { line: 0, char: 0, length: 3, type: 'macro', modifiers: [] },
      { line: 0, char: 4, length: 2, type: '', modifiers: [], skip: true }
    ]

    const data = reencodeSemanticTokensForMonaco(tokens)

    expect(Array.from(data)).toEqual([0, 0, 3, typeIndex('macro'), 0])
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
