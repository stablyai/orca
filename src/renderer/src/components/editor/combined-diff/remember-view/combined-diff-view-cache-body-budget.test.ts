import { afterEach, describe, expect, it } from 'vitest'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import {
  claimCombinedDiffView,
  clearCombinedDiffViewMemory,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView,
  type CachedCombinedDiffViewState
} from './combined-diff-view-cache'

function section(characters: number, patch: Partial<DiffSection> = {}): DiffSection {
  const originalContent = 'o'.repeat(Math.floor(characters / 2))
  const modifiedContent = 'm'.repeat(Math.ceil(characters / 2))
  return {
    key: 'app.ts',
    path: 'app.ts',
    status: 'modified',
    originalContent,
    modifiedContent,
    collapsed: false,
    loading: false,
    dirty: false,
    contentGeneration: 4,
    diffResult: {
      kind: 'text',
      originalContent,
      modifiedContent,
      originalIsBinary: false,
      modifiedIsBinary: false
    },
    largeDiffRenderLimit: null,
    ...patch
  }
}

function view(sections: DiffSection[]): CachedCombinedDiffViewState {
  return {
    entrySignature: 'entries',
    gitStatusSignature: 'status',
    sections,
    sectionHeights: { 0: 320 },
    loadedIndices: sections.map((_, index) => index)
  }
}

function remember(key: string, sections: DiffSection[]) {
  const lease = claimCombinedDiffView(key, 'workspace')
  rememberCombinedDiffView(lease, {
    view: view(sections),
    scrollTop: 640,
    scrollAnchor: { key: 'app.ts', offset: 12 }
  })
  releaseCombinedDiffView(lease)
  return lease
}

function storedView(key: string): CachedCombinedDiffViewState {
  const stored = readCombinedDiffViewMemory(key)?.view
  expect(stored).toBeDefined()
  if (!stored) {
    throw new Error('Expected remembered diff')
  }
  return stored
}

afterEach(clearCombinedDiffViewMemory)

describe('inactive combined diff body budget', () => {
  it('preserves dirty edits and refused saves when pruning clean siblings', () => {
    const dirty = section(20_000_000, { dirty: true })
    const conflict = section(20_000_000, { saveConflict: true })
    remember('edited', [dirty, conflict, section(6_000_000)])
    remember('second', [section(6_000_000)])
    remember('third', [section(6_000_000)])
    const cached = storedView('edited')
    expect(cached.sections[0]).toBe(dirty)
    expect(cached.sections[1]).toBe(conflict)
    expect(cached.sections[2].originalContent.length).toBe(0)
    expect(cached.sections[2]).toMatchObject({
      loading: true,
      originalContent: '',
      diffResult: null
    })
    expect(cached.loadedIndices).toEqual([0, 1])
  })
})
