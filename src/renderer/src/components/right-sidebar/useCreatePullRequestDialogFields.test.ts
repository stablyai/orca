import { describe, expect, it } from 'vitest'
import { normalizeCreateReviewBaseSearchResults } from './useCreatePullRequestDialogFields'

describe('normalizeCreateReviewBaseSearchResults', () => {
  it('uses detailed local branch names for base refs from arbitrary remotes', () => {
    expect(
      normalizeCreateReviewBaseSearchResults([
        {
          refName: 'mycorp-fork/main',
          localBranchName: 'main'
        }
      ])
    ).toEqual(['main'])
  })

  it('dedupes equivalent base branches found on multiple remotes', () => {
    expect(
      normalizeCreateReviewBaseSearchResults([
        {
          refName: 'origin/main',
          localBranchName: 'main'
        },
        {
          refName: 'upstream/main',
          localBranchName: 'main'
        },
        {
          refName: 'mycorp-fork/release/1.0',
          localBranchName: 'release/1.0'
        }
      ])
    ).toEqual(['main', 'release/1.0'])
  })
})
