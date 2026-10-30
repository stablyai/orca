import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from './marine-creatures'
import { selectSuggestedCreatureName, suggestionPathBasename } from './worktree-name-suggestion'

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
  it('skips used names when picking the first available', () => {
    expect(selectSuggestedCreatureName([lower(0)], pickFirst)).toBe(lower(1))
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
    // Compacted tiers are absent from usedNames because all their names are spent.
    expect(selectSuggestedCreatureName([], pickFirst, 2)).toBe(`${lower(0)}-3`)
  })

  it('keeps the watermark and the used set both in force', () => {
    expect(selectSuggestedCreatureName([`${lower(0)}-3`], pickFirst, 2)).toBe(`${lower(1)}-3`)
  })

  it('ignores a nonsense watermark rather than skipping the pool', () => {
    expect(selectSuggestedCreatureName([], pickFirst, -4)).toBe(lower(0))
  })
})
