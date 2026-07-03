import { describe, expect, it } from 'vitest'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import type { DiffSection } from './diff-section-types'
import { combinedDiffSectionsMatchEntryMetadata } from './combined-diff-section-cache-match'

function section(overrides: Partial<DiffSection>): DiffSection {
  return {
    key: 'unstaged:src/file.ts',
    path: 'src/file.ts',
    status: 'modified',
    area: 'unstaged',
    originalContent: '',
    modifiedContent: '',
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null,
    ...overrides
  }
}

describe('combinedDiffSectionsMatchEntryMetadata', () => {
  it('matches sections when keys and entry metadata still match', () => {
    const entry: GitStatusEntry = {
      path: 'src/file.ts',
      status: 'modified',
      area: 'unstaged',
      added: 2,
      removed: 1
    }

    expect(
      combinedDiffSectionsMatchEntryMetadata({
        entries: [entry],
        sections: [section({ added: 2, removed: 1 })],
        treeMode: 'uncommitted'
      })
    ).toBe(true)
  })

  it('rejects cached sections when a same-path entry has new line counts', () => {
    const entry: GitStatusEntry = {
      path: 'src/file.ts',
      status: 'modified',
      area: 'unstaged',
      added: 177,
      removed: 175
    }

    expect(
      combinedDiffSectionsMatchEntryMetadata({
        entries: [entry],
        sections: [section({ added: 2, removed: 1 })],
        treeMode: 'uncommitted'
      })
    ).toBe(false)
  })

  it('keeps branch sections separate when old paths change for the same new path', () => {
    const entry: GitBranchChangeEntry = {
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
      added: 4,
      removed: 3
    }

    expect(
      combinedDiffSectionsMatchEntryMetadata({
        entries: [entry],
        sections: [
          section({
            key: 'combined-branch:src/new.ts',
            path: 'src/new.ts',
            status: 'renamed',
            area: undefined,
            oldPath: 'src/older.ts',
            added: 4,
            removed: 3
          })
        ],
        treeMode: 'branch'
      })
    ).toBe(false)
  })
})
