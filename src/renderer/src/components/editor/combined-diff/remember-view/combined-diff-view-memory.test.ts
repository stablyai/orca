import { afterEach, describe, expect, it } from 'vitest'
import type { DiffSection } from '../../diff-section-types'
import {
  COMBINED_DIFF_VIEW_CACHE_MAX_CHARS,
  combinedDiffViewStateCache,
  rememberCombinedDiffViewState,
  type CachedCombinedDiffViewState
} from './combined-diff-view-memory'

function section(path: string, chars: number): DiffSection {
  const half = 'x'.repeat(Math.floor(chars / 2))
  return {
    key: path,
    path,
    status: 'modified',
    originalContent: half,
    modifiedContent: half,
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: {
      kind: 'text',
      originalContent: half,
      modifiedContent: half,
      originalIsBinary: false,
      modifiedIsBinary: false
    },
    largeDiffRenderLimit: null
  }
}

function view(chars: number): CachedCombinedDiffViewState {
  return {
    entrySignature: 'sig',
    gitStatusSignature: '',
    sections: [section('a.ts', chars)],
    sectionHeights: {},
    loadedIndices: [0],
    scrollTop: 0,
    sideBySide: false
  }
}

afterEach(() => {
  combinedDiffViewStateCache.clear()
})

describe('rememberCombinedDiffViewState', () => {
  it('evicts the least recently stored views once their file text exceeds the budget', () => {
    const quarter = COMBINED_DIFF_VIEW_CACHE_MAX_CHARS / 4
    for (const key of ['a', 'b', 'c', 'd']) {
      rememberCombinedDiffViewState(key, view(quarter))
    }
    expect([...combinedDiffViewStateCache.keys()]).toEqual(['a', 'b', 'c', 'd'])

    rememberCombinedDiffViewState('a', view(quarter))
    rememberCombinedDiffViewState('e', view(quarter))

    expect([...combinedDiffViewStateCache.keys()]).toEqual(['c', 'd', 'a', 'e'])
  })

  it('refuses a view larger than the whole budget without evicting the others', () => {
    rememberCombinedDiffViewState('small', view(1000))
    rememberCombinedDiffViewState('huge', view(1000))
    rememberCombinedDiffViewState('huge', view(COMBINED_DIFF_VIEW_CACHE_MAX_CHARS + 2))

    expect([...combinedDiffViewStateCache.keys()]).toEqual(['small'])
  })

  it('never evicts a view holding unsaved edits for the budget', () => {
    const drafted = view(COMBINED_DIFF_VIEW_CACHE_MAX_CHARS + 2)
    drafted.sections = [{ ...drafted.sections[0], dirty: true }]
    rememberCombinedDiffViewState('drafted', drafted)
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      rememberCombinedDiffViewState(key, view(COMBINED_DIFF_VIEW_CACHE_MAX_CHARS / 4))
    }

    expect([...combinedDiffViewStateCache.keys()]).toEqual(['drafted', 'b', 'c', 'd', 'e'])
  })

  it('keeps the count cap for small views', () => {
    for (let i = 0; i < 25; i++) {
      rememberCombinedDiffViewState(`view-${i}`, view(10))
    }
    expect(combinedDiffViewStateCache.size).toBe(20)
    expect(combinedDiffViewStateCache.has('view-24')).toBe(true)
    expect(combinedDiffViewStateCache.has('view-4')).toBe(false)
  })

  it('counts diff text held only by the diff result', () => {
    const quarter = COMBINED_DIFF_VIEW_CACHE_MAX_CHARS / 4
    const sectionWithSeparateResult = section('b.ts', 0)
    sectionWithSeparateResult.diffResult = {
      kind: 'text',
      originalContent: 'y'.repeat(quarter),
      modifiedContent: 'y'.repeat(quarter),
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    rememberCombinedDiffViewState('result-only', {
      ...view(0),
      sections: [sectionWithSeparateResult]
    })
    rememberCombinedDiffViewState('next', view(quarter * 2 + 2))

    expect([...combinedDiffViewStateCache.keys()]).toEqual(['next'])
  })
})
