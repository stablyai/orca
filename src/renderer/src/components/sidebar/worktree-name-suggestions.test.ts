import { describe, expect, it } from 'vitest'
import { sanitizeWorktreeName } from '../../../../main/ipc/worktree-logic'
import { FISH_NAMES } from '@/constants/fish-names'
import {
  getSuggestedFishName,
  normalizeSuggestedName,
  shouldApplySuggestedName
} from './worktree-name-suggestions'

describe('getSuggestedFishName', () => {
  it('returns the first fish name when no repo is selected', () => {
    expect(getSuggestedFishName('', {}, false)).toBe(FISH_NAMES[0])
  })

  it('skips names already used in the selected repo', () => {
    expect(
      getSuggestedFishName(
        'repo-1',
        {
          'repo-1': [{ path: '/tmp/worktrees/Salmon' }, { path: '/tmp/worktrees/Trout' }]
        },
        true
      )
    ).toBe('Tuna')
  })

  it('checks all repos when nestWorkspaces is false', () => {
    expect(
      getSuggestedFishName(
        'repo-1',
        {
          'repo-1': [],
          'repo-2': [{ path: '/tmp/worktrees/Salmon' }]
        },
        false
      )
    ).toBe('Trout')
  })

  it('only checks the selected repo when nestWorkspaces is true', () => {
    expect(
      getSuggestedFishName(
        'repo-1',
        {
          'repo-1': [],
          'repo-2': [{ path: '/tmp/worktrees/Salmon' }]
        },
        true
      )
    ).toBe('Salmon')
  })

  it('falls back to suffixed variants after the base list is exhausted', () => {
    const usedWorktrees = FISH_NAMES.map((fishName) => ({ path: `/tmp/worktrees/${fishName}` }))

    expect(
      getSuggestedFishName(
        'repo-1',
        {
          'repo-1': usedWorktrees
        },
        true
      )
    ).toBe(`${FISH_NAMES[0]}-2`)
  })

  it('treats used names case-insensitively', () => {
    expect(
      getSuggestedFishName(
        'repo-1',
        {
          'repo-1': [{ path: '/tmp/worktrees/sAlMoN' }]
        },
        true
      )
    ).toBe('Trout')
  })

  it('handles Windows-style worktree paths when deriving used basenames', () => {
    expect(
      getSuggestedFishName(
        'repo-1',
        {
          'repo-1': [{ path: 'C:\\worktrees\\Salmon' }]
        },
        true
      )
    ).toBe('Trout')
  })

  it('handles stored worktree paths with trailing separators', () => {
    expect(
      getSuggestedFishName(
        'repo-1',
        {
          'repo-1': [{ path: 'C:\\worktrees\\Salmon\\\\' }, { path: '/tmp/worktrees/Trout///' }]
        },
        true
      )
    ).toBe('Tuna')
  })
})

describe('shouldApplySuggestedName', () => {
  it('applies a suggestion when the field is blank', () => {
    expect(shouldApplySuggestedName('', 'Salmon')).toBe(true)
    expect(shouldApplySuggestedName('   ', 'Salmon')).toBe(true)
  })

  it('applies a recomputed suggestion when the current value is still the prior suggestion', () => {
    expect(shouldApplySuggestedName('Salmon', 'Salmon')).toBe(true)
  })

  it('does not overwrite a user-edited custom name when the repo selection changes', () => {
    expect(shouldApplySuggestedName('feature/custom-branch', 'Salmon')).toBe(false)
  })
})

describe('FISH_NAMES', () => {
  it('is non-empty and unique after normalization and sanitization', () => {
    expect(FISH_NAMES.length).toBeGreaterThanOrEqual(260)

    const normalizedNames = FISH_NAMES.map(normalizeSuggestedName)
    const sanitizedNames = FISH_NAMES.map((fishName) => sanitizeWorktreeName(fishName))

    expect(new Set(normalizedNames).size).toBe(FISH_NAMES.length)
    expect(new Set(sanitizedNames).size).toBe(FISH_NAMES.length)
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
      'Hardhead'
    ]

    for (const disallowedName of disallowedNames) {
      expect(FISH_NAMES).not.toContain(disallowedName)
    }
  })
})
