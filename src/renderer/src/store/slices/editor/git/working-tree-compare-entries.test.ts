import { describe, expect, it } from 'vitest'
import {
  getWorkingTreeCompareEntries,
  getWorkingTreeCompareLineCounts
} from './working-tree-compare-entries'

describe('working-tree comparison paths', () => {
  it('shows a committed, staged and unstaged file once without adding separate line totals', () => {
    expect(
      getWorkingTreeCompareEntries(
        [{ path: 'file.ts', status: 'modified', added: 1 }],
        [
          { path: 'file.ts', status: 'modified', area: 'unstaged', added: 1 },
          { path: 'file.ts', status: 'modified', area: 'staged', added: 1 }
        ]
      )
    ).toEqual([
      {
        path: 'file.ts',
        branchPath: 'file.ts',
        status: 'modified',
        added: undefined,
        removed: undefined,
        oldPath: undefined
      }
    ])
  })
  it('follows committed and staged renames back to the merge-base path', () => {
    expect(
      getWorkingTreeCompareEntries(
        [{ path: 'second.ts', oldPath: 'first.ts', status: 'renamed' }],
        [
          { path: 'third.ts', status: 'modified', area: 'unstaged' },
          { path: 'third.ts', oldPath: 'second.ts', status: 'renamed', area: 'staged' }
        ]
      )
    ).toEqual([
      expect.objectContaining({
        path: 'third.ts',
        oldPath: 'first.ts',
        branchPath: 'second.ts',
        status: 'renamed'
      })
    ])
  })
  it('includes untracked and deleted paths but excludes unresolved branch conflicts', () => {
    expect(
      getWorkingTreeCompareEntries(
        [
          { path: 'conflict.ts', status: 'modified' },
          { path: 'deleted.ts', status: 'modified' }
        ],
        [
          { path: 'new.ts', status: 'untracked', area: 'untracked' },
          { path: 'deleted.ts', status: 'deleted', area: 'unstaged' },
          {
            path: 'conflict.ts',
            status: 'modified',
            area: 'unstaged',
            conflictStatus: 'unresolved'
          }
        ]
      )
    ).toEqual([
      expect.objectContaining({ path: 'deleted.ts', status: 'deleted' }),
      expect.objectContaining({ path: 'new.ts', status: 'added' })
    ])
  })
})

it('retains conservative size estimates separately from net line totals', () => {
  expect(
    getWorkingTreeCompareLineCounts(
      [{ path: 'file.ts', status: 'modified', added: 1, removed: 1 }],
      [
        { path: 'file.ts', status: 'modified', area: 'staged', added: 2, removed: 2 },
        { path: 'file.ts', status: 'modified', area: 'unstaged', added: 3, removed: 3 }
      ]
    )
  ).toEqual({ 'file.ts': { added: 6, removed: 6 } })
  expect(getWorkingTreeCompareLineCounts([{ path: 'unknown', status: 'modified' }], [])).toEqual({})
})

it('accumulates both halves of a porcelain RM rename and preserves unknown sizes', () => {
  const staged = {
    path: 'new.ts',
    oldPath: 'old.ts',
    status: 'renamed' as const,
    area: 'staged' as const,
    added: 3000,
    removed: 3000
  }
  const unstaged = {
    ...staged,
    status: 'modified' as const,
    area: 'unstaged' as const,
    added: 3000,
    removed: 3000
  }
  expect(getWorkingTreeCompareLineCounts([], [staged, unstaged])).toEqual({
    'new.ts': { added: 6000, removed: 6000 }
  })
  expect(getWorkingTreeCompareLineCounts([], [{ ...staged, added: undefined }, unstaged])).toEqual(
    {}
  )
  expect(
    getWorkingTreeCompareLineCounts(
      [{ path: 'old.ts', status: 'modified', added: 1, removed: 1 }],
      [staged, unstaged]
    )
  ).toEqual({ 'new.ts': { added: 6001, removed: 6001 } })
})
it('keeps copied files copied after edits and marks recreated base files modified', () => {
  expect(
    getWorkingTreeCompareEntries(
      [{ path: 'copy.ts', oldPath: 'source.ts', status: 'copied' }],
      [{ path: 'copy.ts', status: 'modified', area: 'unstaged' }]
    )[0].status
  ).toBe('copied')
  expect(
    getWorkingTreeCompareEntries(
      [{ path: 'restored.ts', status: 'deleted' }],
      [{ path: 'restored.ts', status: 'untracked', area: 'untracked' }]
    )[0].status
  ).toBe('modified')
})
