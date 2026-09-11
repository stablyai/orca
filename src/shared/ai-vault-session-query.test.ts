import { describe, expect, it } from 'vitest'
import {
  expandAiVaultSearchTerms,
  parseVaultQuery,
  timeRangeStartMs,
  tokenizeIndexText
} from './ai-vault-session-query'

describe('parseVaultQuery', () => {
  it('keeps quoted terms and new dimension operators', () => {
    expect(
      parseVaultQuery(
        '"resume picker" repo:orca path:src cwd:app model:sonnet branch:fix host:wsl after:2026-05-01 before:2026-06-01'
      )
    ).toEqual({
      terms: ['resume picker'],
      repoTerms: ['orca'],
      pathTerms: ['src', 'app'],
      modelTerms: ['sonnet'],
      branchTerms: ['fix'],
      hostTerms: ['wsl'],
      afterMs: Date.parse('2026-05-01'),
      beforeMs: Date.parse('2026-06-01')
    })
  })
})

describe('expandAiVaultSearchTerms', () => {
  it('drops stopwords from a natural-language query', () => {
    expect(expandAiVaultSearchTerms('the PR where we fixed pairing on Linux')).toEqual([
      'pr',
      'fixed',
      'pairing',
      'linux'
    ])
  })

  it('keeps CJK and accented query tokens', () => {
    expect(expandAiVaultSearchTerms('真假四人')).toEqual(['真假四人'])
    expect(expandAiVaultSearchTerms('café')).toEqual(['café'])
  })
})

describe('tokenizeIndexText', () => {
  it('splits on Unicode letters and numbers instead of ASCII only', () => {
    expect(tokenizeIndexText('真假四人')).toEqual(['真假四人'])
    expect(tokenizeIndexText('café')).toEqual(['café'])
    expect(tokenizeIndexText('東京')).toEqual(['東京'])
    expect(tokenizeIndexText('你好 world')).toEqual(['你好', 'world'])
  })
})

describe('timeRangeStartMs', () => {
  it('returns a 7-day window and none for all', () => {
    const nowMs = Date.parse('2026-05-08T00:00:00.000Z')
    expect(timeRangeStartMs('7d', nowMs)).toBe(nowMs - 7 * 24 * 60 * 60 * 1000)
    expect(timeRangeStartMs('all', nowMs)).toBeNull()
  })
})
