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
    diffResult: {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    },
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

  it('permutes sourceIndexes when an area move reorders without changing count', () => {
    const stagedB = section({
      key: 'staged:src/b.ts',
      path: 'src/b.ts',
      area: 'staged',
      originalContent: 'b-old',
      modifiedContent: 'b-new'
    })
    const stagedD = section({
      key: 'staged:src/d.ts',
      path: 'src/d.ts',
      area: 'staged',
      originalContent: 'd-old',
      modifiedContent: 'd-new'
    })
    const unstagedA = section({
      key: 'unstaged:src/a.ts',
      path: 'src/a.ts',
      area: 'unstaged',
      originalContent: 'a-old',
      modifiedContent: 'a-new'
    })
    const unstagedC = section({
      key: 'unstaged:src/c.ts',
      path: 'src/c.ts',
      area: 'unstaged',
      originalContent: 'c-old',
      modifiedContent: 'c-new'
    })
    const entries: GitStatusEntry[] = [
      { path: 'src/a.ts', status: 'modified', area: 'staged' },
      { path: 'src/b.ts', status: 'modified', area: 'staged' },
      { path: 'src/d.ts', status: 'modified', area: 'staged' },
      { path: 'src/c.ts', status: 'modified', area: 'unstaged' }
    ]

    const remapped = remapCombinedDiffSectionsForAreaMove({
      sections: [stagedB, stagedD, unstagedA, unstagedC],
      entries,
      treeMode: 'all'
    })

    expect(remapped?.sourceIndexes).toEqual([2, 0, 1, 3])
    expect(remapped?.sections.map((row) => row.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/d.ts',
      'src/c.ts'
    ])
    expect(remapped?.sections[0]).toMatchObject({
      key: 'unstaged:src/a.ts',
      area: 'staged',
      modifiedContent: 'a-new'
    })
    expect(
      remapCombinedDiffSectionHeights({ 0: 100, 1: 200, 2: 300, 3: 400 }, remapped!.sourceIndexes)
    ).toEqual({ 0: 300, 1: 100, 2: 200, 3: 400 })
  })
})

describe('remapCombinedDiffSectionHeights', () => {
  it('reindexes heights after a removal', () => {
    expect(remapCombinedDiffSectionHeights({ 0: 120, 1: 340, 2: 50 }, [1, 2])).toEqual({
      0: 340,
      1: 50
    })
  })

  it('reindexes heights for a same-length permutation', () => {
    expect(
      remapCombinedDiffSectionHeights({ 0: 100, 1: 200, 2: 300, 3: 400 }, [2, 0, 1, 3])
    ).toEqual({
      0: 300,
      1: 100,
      2: 200,
      3: 400
    })
  })
})
