import { describe, expect, it } from 'vitest'
import {
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from './file-name-filter-tokens'

function matches(path: string, query: string): boolean {
  return pathMatchesFileNameFilterTokens(path, splitFileNameFilterTokens(query))
}

describe('pathMatchesFileNameFilterTokens', () => {
  it('matches across composed (NFC) and decomposed (NFD) spellings', () => {
    expect(matches('docs/회의록.md'.normalize('NFD'), '회의'.normalize('NFC'))).toBe(true)
    expect(matches('Café-Notes.md'.normalize('NFD'), 'café'.normalize('NFC'))).toBe(true)
    expect(matches('docs/회의록.md'.normalize('NFC'), '회의'.normalize('NFD'))).toBe(true)
  })
})
