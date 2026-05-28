import { describe, expect, it } from 'vitest'
import { deriveLegacyLocalBranchName, legacyBaseRefSearchResult } from './base-ref-search-result'

describe('legacyBaseRefSearchResult', () => {
  it('derives local branch names for common remote refs returned by older runtimes', () => {
    expect(deriveLegacyLocalBranchName('origin/feature/something')).toBe('feature/something')
    expect(deriveLegacyLocalBranchName('upstream/release/1.2')).toBe('release/1.2')
  })

  it('keeps local branch refs unchanged when a remote prefix is not known', () => {
    expect(legacyBaseRefSearchResult('feature/something')).toEqual({
      refName: 'feature/something',
      localBranchName: 'feature/something'
    })
  })
})
