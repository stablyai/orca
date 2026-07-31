import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import { compareGitStatusEntries } from './source-control-status-sort'

function entry(path: string, conflictStatus?: GitStatusEntry['conflictStatus']): GitStatusEntry {
  return {
    path,
    area: 'unstaged',
    status: 'modified',
    ...(conflictStatus ? { conflictStatus } : {})
  } as GitStatusEntry
}

// Reference: the pre-change comparator, which resolved a collator per call.
function referenceCompare(a: GitStatusEntry, b: GitStatusEntry): number {
  const rank = (value: GitStatusEntry): number => {
    if (value.conflictStatus === 'unresolved') {
      return 0
    }
    if (value.conflictStatus === 'resolved_locally') {
      return 1
    }
    return 2
  }
  return rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { numeric: true })
}

describe('compareGitStatusEntries', () => {
  // Why pin the order: the shared collator replaced a per-call localeCompare, so
  // the only thing that could regress is the ordering it produces.
  it('orders identically to a per-call localeCompare', () => {
    const paths = [
      'src/a.ts',
      'src/A.ts',
      'src/file2.ts',
      'src/file10.ts',
      'src/file1.ts',
      'src/File3.ts',
      'src/nested/deep/z.ts',
      'src/nested/a.ts',
      'README.md',
      'package.json',
      'src/日本語.ts',
      'src/émoji.ts',
      'src/file-2.ts',
      'src/file_2.ts',
      'src/10.ts',
      'src/9.ts'
    ]
    const entries = paths.map((path) => entry(path))
    const sorted = [...entries].sort(compareGitStatusEntries).map((value) => value.path)
    const reference = [...entries].sort(referenceCompare).map((value) => value.path)
    expect(sorted).toEqual(reference)
  })

  it('keeps conflicts ahead of clean paths regardless of name', () => {
    const entries = [
      entry('z-clean.ts'),
      entry('a-resolved.ts', 'resolved_locally'),
      entry('m-unresolved.ts', 'unresolved')
    ]
    expect([...entries].sort(compareGitStatusEntries).map((value) => value.path)).toEqual([
      'm-unresolved.ts',
      'a-resolved.ts',
      'z-clean.ts'
    ])
  })

  it('sorts numeric path segments naturally', () => {
    const entries = ['f10.ts', 'f9.ts', 'f1.ts'].map((path) => entry(path))
    expect([...entries].sort(compareGitStatusEntries).map((value) => value.path)).toEqual([
      'f1.ts',
      'f9.ts',
      'f10.ts'
    ])
  })
})
