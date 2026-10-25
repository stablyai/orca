import { describe, expect, it } from 'vitest'
import { sanitizeWorktreeName } from '../../../../main/ipc/worktree-logic'
import { MARINE_CREATURES } from '@/constants/marine-creatures'
import {
  getSuggestedCreatureName,
  normalizeSuggestedName,
  shouldApplySuggestedName
} from './worktree-name-suggestions'

const pickFirst = () => 0
const lower = (index: number) => MARINE_CREATURES[index].toLowerCase()
const retiring = (...names: string[]) => ({ exhaustedTiers: 0, names })

describe('getSuggestedCreatureName', () => {
  it('picks the first unused name when the RNG selects index 0', () => {
    expect(getSuggestedCreatureName({}, pickFirst)).toBe(lower(0))
  })

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

  it('never reuses a name already used in another repo', () => {
    expect(
      getSuggestedCreatureName(
        {
          'repo-1': [],
          'repo-2': [{ path: `/tmp/worktrees/${MARINE_CREATURES[0]}` }]
        },
        pickFirst
      )
    ).toBe(lower(1))
  })

  it('selects randomly from the unused pool', () => {
    // random() = i/N ⇒ pickRandom returns the pool's i-th entry.
    const pickIndex = (index: number, poolSize: number) => () => index / poolSize
    expect(getSuggestedCreatureName({}, pickIndex(2, MARINE_CREATURES.length))).toBe(lower(2))
    expect(getSuggestedCreatureName({}, pickIndex(5, MARINE_CREATURES.length))).toBe(lower(5))
  })

  it('falls back to suffixed variants after the base list is exhausted', () => {
    const usedWorktrees = MARINE_CREATURES.map((name) => ({ path: `/tmp/worktrees/${name}` }))

    expect(getSuggestedCreatureName({ 'repo-1': usedWorktrees }, pickFirst)).toBe(`${lower(0)}-2`)
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

  it('treats used names case-insensitively', () => {
    expect(
      getSuggestedCreatureName({ 'repo-1': [{ path: '/tmp/worktrees/nAuTiLuS' }] }, pickFirst)
    ).toBe(lower(1))
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
  it('applies a suggestion when the field is blank', () => {
    expect(shouldApplySuggestedName('', 'Nautilus')).toBe(true)
    expect(shouldApplySuggestedName('   ', 'Nautilus')).toBe(true)
  })

  it('applies a recomputed suggestion when the current value is still the prior suggestion', () => {
    expect(shouldApplySuggestedName('Nautilus', 'Nautilus')).toBe(true)
  })

  it('does not overwrite a user-edited custom name when the repo selection changes', () => {
    expect(shouldApplySuggestedName('feature/custom-branch', 'Nautilus')).toBe(false)
  })
})

describe('MARINE_CREATURES', () => {
  it('is non-empty and unique after normalization and sanitization', () => {
    expect(MARINE_CREATURES.length).toBeGreaterThanOrEqual(500)

    const normalizedNames = MARINE_CREATURES.map(normalizeSuggestedName)
    const sanitizedNames = MARINE_CREATURES.map((name) => sanitizeWorktreeName(name))

    expect(new Set(normalizedNames).size).toBe(MARINE_CREATURES.length)
    expect(new Set(sanitizedNames).size).toBe(MARINE_CREATURES.length)
  })

  it('avoids names that read poorly as UI defaults', () => {
    const disallowedNames = [
      'Crappie',
      'Sucker',
      'Spadefish',
      'Lumpsucker',
      'Hogchoker',
      'Hogsucker',
      'Mudsucker',
      'Hardhead',
      // These sea-organism names read as fruit, flowers or land insects without context.
      'Olive',
      'Tulip',
      'Cone',
      'Mantis'
    ]

    for (const disallowedName of disallowedNames) {
      expect(MARINE_CREATURES).not.toContain(disallowedName)
    }
  })
})
