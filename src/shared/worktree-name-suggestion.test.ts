import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from './marine-creatures'
import {
  normalizeSuggestedName,
  selectSuggestedCreatureName,
  suggestionPathBasename
} from './worktree-name-suggestion'

const pickFirst = () => 0
const lower = (index: number) => MARINE_CREATURES[index].toLowerCase()

describe('suggestionPathBasename', () => {
  it('handles POSIX, Windows, and trailing separators identically', () => {
    expect(suggestionPathBasename('/tmp/worktrees/Nautilus')).toBe('Nautilus')
    expect(suggestionPathBasename('C:\\worktrees\\Nautilus')).toBe('Nautilus')
    expect(suggestionPathBasename('/tmp/worktrees/Nautilus///')).toBe('Nautilus')
    expect(suggestionPathBasename('C:\\worktrees\\Nautilus\\\\')).toBe('Nautilus')
  })
})

describe('selectSuggestedCreatureName', () => {
  it('returns a name absent from the used set', () => {
    // Anchored on absence rather than pool position: asserting an index would keep passing
    // against a filtered pool while testing nothing.
    const used = [lower(0), lower(1), lower(2)]
    const suggested = selectSuggestedCreatureName(used)
    expect(used).not.toContain(suggested)
  })

  it('skips used names when picking the first available', () => {
    expect(selectSuggestedCreatureName([lower(0)], pickFirst)).toBe(lower(1))
  })

  it('normalizes the used set so case and padding cannot smuggle a name back in', () => {
    const suggested = selectSuggestedCreatureName([`  ${MARINE_CREATURES[0].toUpperCase()} `])
    expect(suggested).not.toBe(lower(0))
  })

  it('degrades to a suffixed tier once every base name is spent', () => {
    const allUsed = MARINE_CREATURES.map((name) => name.toLowerCase())
    expect(selectSuggestedCreatureName(allUsed, pickFirst)).toBe(`${lower(0)}-2`)
  })

  it('does not rewind onto a spent variant within a tier', () => {
    const allUsed = [...MARINE_CREATURES.map((name) => name.toLowerCase()), `${lower(0)}-2`]
    expect(selectSuggestedCreatureName(allUsed, pickFirst)).toBe(`${lower(1)}-2`)
  })

  it('advances to the next tier when a whole tier is spent', () => {
    const allUsed = [
      ...MARINE_CREATURES.map((name) => name.toLowerCase()),
      ...MARINE_CREATURES.map((name) => `${name.toLowerCase()}-2`)
    ]
    expect(selectSuggestedCreatureName(allUsed, pickFirst)).toBe(`${lower(0)}-3`)
  })

  it('starts above the exhausted-tier watermark instead of looking those names up', () => {
    // The registry compacts a fully spent tier away, so its names are absent from the used set
    // precisely because they are all taken. Starting at tier 1 would hand one straight back.
    expect(selectSuggestedCreatureName([], pickFirst, 2)).toBe(`${lower(0)}-3`)
  })

  it('keeps the watermark and the used set both in force', () => {
    expect(selectSuggestedCreatureName([`${lower(0)}-3`], pickFirst, 2)).toBe(`${lower(1)}-3`)
  })

  it('ignores a nonsense watermark rather than skipping the pool', () => {
    expect(selectSuggestedCreatureName([], pickFirst, -4)).toBe(lower(0))
  })

  it('returns a lowercase name to match branch convention', () => {
    // Pool entries are capitalized; branch names are conventionally lowercase.
    const suggested = selectSuggestedCreatureName([], pickFirst)
    expect(suggested).toBe(suggested.toLowerCase())
    expect(MARINE_CREATURES).toContain(suggested.charAt(0).toUpperCase() + suggested.slice(1))
  })
})

describe('normalizeSuggestedName', () => {
  it('trims and lowercases', () => {
    expect(normalizeSuggestedName('  Nautilus  ')).toBe('nautilus')
  })
})
