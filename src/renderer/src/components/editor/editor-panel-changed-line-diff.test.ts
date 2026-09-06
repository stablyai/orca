import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import {
  getChangedLineDiffFile,
  shouldLoadChangedLineDiffForEditFile
} from './editor-panel-changed-line-diff'

function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/src/file.ts',
    filePath: '/repo/src/file.ts',
    relativePath: 'src/file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('shouldLoadChangedLineDiffForEditFile', () => {
  it('loads the diff baseline for changed editable files', () => {
    const entries: GitStatusEntry[] = [
      { path: 'src/file.ts', status: 'modified', area: 'unstaged' }
    ]

    expect(shouldLoadChangedLineDiffForEditFile(makeFile(), entries)).toBe(true)
  })

  it('loads the diff baseline for files changed only in the branch comparison', () => {
    const branchEntries: GitBranchChangeEntry[] = [
      { path: 'src/file.ts', status: 'modified' }
    ]

    expect(shouldLoadChangedLineDiffForEditFile(makeFile(), [], branchEntries)).toBe(true)
  })

  it('uses branch diff metadata when no uncommitted entry exists', () => {
    const file = makeFile()
    const branchCompare = {
      baseRef: 'origin/main',
      compareRef: 'feature/example',
      compareVersion: 'feature/example',
      baseOid: 'base',
      headOid: 'head',
      mergeBase: 'merge-base'
    }

    expect(
      getChangedLineDiffFile(
        file,
        [],
        [{ path: 'src/file.ts', status: 'renamed', oldPath: 'src/old-file.ts' }],
        branchCompare
      )
    ).toMatchObject({
      diffSource: 'branch',
      branchCompare,
      branchOldPath: 'src/old-file.ts'
    })
  })

  it('keeps uncommitted entries on the working-tree diff baseline', () => {
    const file = makeFile()

    expect(
      getChangedLineDiffFile(
        file,
        [{ path: 'src/file.ts', status: 'modified', area: 'unstaged' }],
        [{ path: 'src/file.ts', status: 'modified' }],
        {
          baseRef: 'origin/main',
          compareRef: 'feature/example',
          compareVersion: 'feature/example',
          baseOid: 'base',
          headOid: 'head',
          mergeBase: 'merge-base'
        }
      )
    ).toBe(file)
  })

  it('skips clean, deleted, read-only, and external edit tabs', () => {
    expect(shouldLoadChangedLineDiffForEditFile(makeFile(), [])).toBe(false)
    expect(
      shouldLoadChangedLineDiffForEditFile(makeFile(), [
        { path: 'src/file.ts', status: 'deleted', area: 'unstaged' }
      ])
    ).toBe(false)
    expect(
      shouldLoadChangedLineDiffForEditFile(makeFile({ readOnly: true }), [
        { path: 'src/file.ts', status: 'modified', area: 'unstaged' }
      ])
    ).toBe(false)
    expect(
      shouldLoadChangedLineDiffForEditFile(makeFile({ relativePath: '/tmp/file.ts' }), [
        { path: '/tmp/file.ts', status: 'modified', area: 'unstaged' }
      ])
    ).toBe(false)
  })
})
