import { describe, expect, it } from 'vitest'

import { MARINE_CREATURES } from '@/constants/marine-creatures'
import { getSuggestedCreatureName, shouldApplySuggestedName } from './worktree-name-suggestions'

const pickFirst = () => 0
const lower = (index: number) => MARINE_CREATURES[index].toLowerCase()
const retiring = (...names: string[]) => ({ exhaustedTiers: 0, names })

describe('getSuggestedCreatureName', () => {
  it('dedupes against worktrees in EVERY repo, not just one', () => {
    expect(
      getSuggestedCreatureName(
        {
          'repo-1': [{ path: '/tmp/worktrees/Nautilus' }],
          'repo-2': [{ path: '/tmp/worktrees/Seahorse' }]
        },
        pickFirst
      )
    ).toBe(lower(2))
  })

  it('never reissues a retired name whose workspace is already deleted', () => {
    // Reusing a deleted workspace’s name reuses its path and can expose the previous agent conversation.
    expect(getSuggestedCreatureName({}, pickFirst, retiring(MARINE_CREATURES[0]))).toBe(lower(1))
  })

  it('treats retired names case-insensitively', () => {
    expect(
      getSuggestedCreatureName({}, pickFirst, retiring(MARINE_CREATURES[0].toUpperCase()))
    ).toBe(lower(1))
  })

  it('retires names on top of live worktrees rather than replacing that check', () => {
    expect(
      getSuggestedCreatureName(
        { 'repo-1': [{ path: `/tmp/worktrees/${MARINE_CREATURES[0]}` }] },
        pickFirst,
        retiring(MARINE_CREATURES[1])
      )
    ).toBe(lower(2))
  })

  it('skips a retired suffixed variant when falling back past an exhausted pool', () => {
    const allUsed = MARINE_CREATURES.map((name) => ({ path: `/tmp/worktrees/${name}` }))
    expect(
      getSuggestedCreatureName({ 'repo-1': allUsed }, pickFirst, retiring(`${lower(0)}-2`))
    ).toBe(`${lower(1)}-2`)
  })

  it('handles Windows-style worktree paths when deriving used basenames', () => {
    expect(
      getSuggestedCreatureName({ 'repo-1': [{ path: 'C:\\worktrees\\Nautilus' }] }, pickFirst)
    ).toBe(lower(1))
  })

  it('handles stored worktree paths with trailing separators', () => {
    expect(
      getSuggestedCreatureName(
        {
          'repo-1': [
            { path: 'C:\\worktrees\\Nautilus\\\\' },
            { path: '/tmp/worktrees/Seahorse///' }
          ]
        },
        pickFirst
      )
    ).toBe(lower(2))
  })
})

describe('shouldApplySuggestedName', () => {
  it('does not overwrite a user-edited custom name when the repo selection changes', () => {
    expect(shouldApplySuggestedName('feature/custom-branch', 'Nautilus')).toBe(false)
  })
})
