import { afterEach, describe, expect, it } from 'vitest'
import type { DiffSection } from '../../diff-section-types'
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
    loadedIndices: sections.map((_, index) => index),
    sideBySide: true
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
  it('releases oldest clean bodies while retaining restoration metadata and reload state', () => {
    const first = section(6_000_000)
    remember('first', [first])
    remember('second', [section(6_000_000)])
    remember('third', [section(6_000_000)])

    expect(storedView('first').sections[0].originalContent.length).toBe(0)
    expect(storedView('first')).toEqual({
      ...view([first]),
      loadedIndices: [],
      sections: [
        {
          ...first,
          originalContent: '',
          modifiedContent: '',
          diffResult: null,
          loading: true,
          error: undefined,
          contentGeneration: 5
        }
      ]
    })
    expect(readCombinedDiffViewMemory('first')).toMatchObject({
      scrollTop: 640,
      scrollAnchor: { key: 'app.ts', offset: 12 }
    })
    expect(storedView('second').sections[0].originalContent).toHaveLength(3_000_000)
    expect(storedView('third').loadedIndices).toEqual([0])
    expect(first.loading).toBe(false)
    expect(first.originalContent).toHaveLength(3_000_000)
  })

  it('protects mounted content and trims it when its final mount releases', () => {
    const sections = [section(6_000_000), section(6_000_000), section(6_000_000)]
    const mounted = claimCombinedDiffView('mounted', 'workspace')
    const otherMount = claimCombinedDiffView('mounted', 'workspace')
    rememberCombinedDiffView(mounted, { view: view(sections) })
    remember('inactive', [section(6_000_000)])
    releaseCombinedDiffView(mounted)
    expect(storedView('mounted').sections).toBe(sections)
    releaseCombinedDiffView(otherMount)
    expect(storedView('mounted').sections.every((item) => item.loading)).toBe(true)
    expect(storedView('inactive').loadedIndices).toEqual([0])
  })

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

  it('counts binary bodies and counts mirrored text bodies once', () => {
    remember('text', [section(6_000_000), section(6_000_000)])
    const binary = section(0, {
      diffResult: {
        kind: 'binary',
        originalContent: 'a'.repeat(2_000_000),
        modifiedContent: 'b'.repeat(2_000_000),
        originalIsBinary: true,
        modifiedIsBinary: true,
        isImage: true,
        mimeType: 'image/png'
      }
    })
    remember('image', [binary])
    expect(storedView('text').loadedIndices).toEqual([0, 1])
    expect(storedView('image').sections[0]).toBe(binary)
    remember('overflow', [section(2)])
    expect(storedView('text').loadedIndices).toEqual([])
    expect(storedView('image').sections[0]).toBe(binary)
  })

  it('honors recent scroll writes and accounts replacement snapshots without accumulation', () => {
    const first = remember('first', [section(6_000_000)])
    remember('second', [section(6_000_000)])
    for (let index = 0; index < 30; index++) {
      rememberCombinedDiffView(first, { view: view([section(6_000_000)]), scrollTop: index })
    }
    remember('third', [section(6_000_000)])
    expect(storedView('second').loadedIndices).toEqual([])
    expect(storedView('first').loadedIndices).toEqual([0])
    expect(readCombinedDiffViewMemory('first')?.scrollTop).toBe(29)
  })

  it('trims snapshots written after unmount tracking has released', () => {
    const lease = claimCombinedDiffView('closing', 'workspace')
    releaseCombinedDiffView(lease)
    rememberCombinedDiffView(lease, {
      view: view([section(6_000_000), section(6_000_000), section(6_000_000)])
    })
    expect(storedView('closing').sections.every((item) => item.loading)).toBe(true)
    expect(storedView('closing').loadedIndices).toEqual([])
  })

  it('does not revisit file bodies for scroll-only writes', () => {
    const original = section(100)
    let reads = 0
    const tracked: DiffSection = {
      ...original,
      get originalContent() {
        reads++
        return original.originalContent
      }
    }
    const lease = remember('scrolling', [tracked])
    const initialReads = reads
    for (let index = 0; index < 100; index++) {
      rememberCombinedDiffView(lease, { scrollTop: index })
    }
    expect(reads).toBe(initialReads)
  })
})
