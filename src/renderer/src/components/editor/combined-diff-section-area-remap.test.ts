import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import type { DiffSection } from './diff-section-types'
import {
  remapCombinedDiffSectionHeights,
  remapCombinedDiffSectionsForAreaMove
} from './combined-diff-section-area-remap'

function section(overrides: Partial<DiffSection>): DiffSection {
  return {
    key: 'unstaged:src/file.ts',
    path: 'src/file.ts',
    status: 'modified',
    area: 'unstaged',
    originalContent: 'old',
    modifiedContent: 'new',
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: { kind: 'text', originalContent: 'old', modifiedContent: 'new' },
    largeDiffRenderLimit: null,
    ...overrides
  }
}

describe('remapCombinedDiffSectionsForAreaMove', () => {
  it('keeps loaded content and stable key when only area moves', () => {
    const entry: GitStatusEntry = {
      path: 'src/file.ts',
      status: 'modified',
      area: 'staged',
      added: 2,
      removed: 1
    }
    const existing = section({ added: 2, removed: 1 })

    expect(
      remapCombinedDiffSectionsForAreaMove({
        sections: [existing],
        entries: [entry],
        treeMode: 'all'
      })
    ).toEqual({
      sections: [
        {
          ...existing,
          key: 'unstaged:src/file.ts',
          area: 'staged',
          added: 2,
          removed: 1
        }
      ],
      sourceIndexes: [0]
    })
  })

  it('drops removed paths while keeping remaining loaded sections', () => {
    const keep = section({
      key: 'staged:src/keep.ts',
      path: 'src/keep.ts',
      area: 'staged',
      originalContent: 'keep-old',
      modifiedContent: 'keep-new'
    })
    const gone = section({
      key: 'untracked:src/gone.ts',
      path: 'src/gone.ts',
      area: 'untracked',
      status: 'untracked'
    })
    const keepEntry: GitStatusEntry = {
      path: 'src/keep.ts',
      status: 'modified',
      area: 'staged'
    }

    expect(
      remapCombinedDiffSectionsForAreaMove({
        sections: [gone, keep],
        entries: [keepEntry],
        treeMode: 'all'
      })
    ).toEqual({
      sections: [keep],
      sourceIndexes: [1]
    })
  })

  it('returns the same sections reference when metadata is unchanged', () => {
    const entry: GitStatusEntry = {
      path: 'src/file.ts',
      status: 'modified',
      area: 'unstaged',
      added: 2,
      removed: 1
    }
    const existing = section({ added: 2, removed: 1 })
    const sections = [existing]

    const remapped = remapCombinedDiffSectionsForAreaMove({
      sections,
      entries: [entry],
      treeMode: 'all'
    })
    expect(remapped?.sections).toBe(sections)
  })

  it('returns null when a new path appears', () => {
    const entry: GitStatusEntry = {
      path: 'src/other.ts',
      status: 'modified',
      area: 'staged'
    }

    expect(
      remapCombinedDiffSectionsForAreaMove({
        sections: [section({})],
        entries: [entry],
        treeMode: 'all'
      })
    ).toBeNull()
  })
})

describe('remapCombinedDiffSectionHeights', () => {
  it('reindexes heights after a removal', () => {
    expect(remapCombinedDiffSectionHeights({ 0: 120, 1: 340, 2: 50 }, [1, 2])).toEqual({
      0: 340,
      1: 50
    })
  })
})
