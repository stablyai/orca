import { describe, expect, it } from 'vitest'
import { resolveTaskSourceSelectionSwap } from './task-source-selection-swap'

describe('resolveTaskSourceSelectionSwap', () => {
  it('stashes the outgoing source selection and restores the incoming source stash', () => {
    const { stash, nextSelection } = resolveTaskSourceSelectionSwap({
      previousSource: 'github',
      nextSource: 'gitlab',
      currentSelection: new Set(['gh-repo-1', 'gh-repo-2']),
      stash: { gitlab: new Set(['gl-repo-1']) },
      fallbackSelection: new Set(['default'])
    })
    expect([...stash.github ?? []].sort()).toEqual(['gh-repo-1', 'gh-repo-2'])
    expect([...nextSelection]).toEqual(['gl-repo-1'])
  })

  it('falls back to the page initial selection on a source never visited (#15784)', () => {
    const { stash, nextSelection } = resolveTaskSourceSelectionSwap({
      previousSource: 'gitlab',
      nextSource: 'github',
      currentSelection: new Set(['gl-repo-1']),
      stash: {},
      fallbackSelection: new Set(['default-1', 'default-2'])
    })
    expect([...stash.gitlab ?? []]).toEqual(['gl-repo-1'])
    expect([...nextSelection].sort()).toEqual(['default-1', 'default-2'])
  })

  it('round-trips: switching back restores the first selection untouched', () => {
    const first = resolveTaskSourceSelectionSwap({
      previousSource: 'github',
      nextSource: 'linear',
      currentSelection: new Set(['gh-1']),
      stash: {},
      fallbackSelection: new Set(['default'])
    })
    const back = resolveTaskSourceSelectionSwap({
      previousSource: 'linear',
      nextSource: 'github',
      currentSelection: first.nextSelection,
      stash: first.stash,
      fallbackSelection: new Set(['default'])
    })
    expect([...back.nextSelection]).toEqual(['gh-1'])
  })
})
