import { describe, expect, it } from 'vitest'
import { normalizeMatchQuery, scoreQueryTokens, tokenizeMatchValue } from './query-token-match'

describe('query token match', () => {
  it('normalizes case and collapses whitespace', () => {
    expect(normalizeMatchQuery('  New   Terminal ')).toBe('new terminal')
  })

  it('tokenizes on non-alphanumeric boundaries', () => {
    expect(tokenizeMatchValue('GitHub Copilot-cli')).toEqual(['github', 'copilot', 'cli'])
  })

  it('ranks exact tokens above prefixes above substrings', () => {
    const exact = scoreQueryTokens('terminal', ['terminal'])
    const prefix = scoreQueryTokens('term', ['terminal'])
    const substring = scoreQueryTokens('rmin', ['terminal'])
    expect(exact.score).toBeGreaterThan(prefix.score)
    expect(prefix.score).toBeGreaterThan(substring.score)
    expect(substring.allTokensMatched).toBe(true)
  })

  it('reports unmatched query tokens', () => {
    const result = scoreQueryTokens('new browser', ['new terminal'])
    expect(result.allTokensMatched).toBe(false)
  })

  it('returns no score for empty inputs', () => {
    expect(scoreQueryTokens('', ['terminal'])).toEqual({ allTokensMatched: false, score: 0 })
    expect(scoreQueryTokens('terminal', [])).toEqual({ allTokensMatched: false, score: 0 })
  })
})
