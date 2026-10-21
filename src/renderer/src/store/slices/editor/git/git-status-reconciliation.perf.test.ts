import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { OpenFile } from '../types/open-file'
import { reconcileOpenFilesForStatus } from './git-status-reconciliation'

function openFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'file',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

const conflict: NonNullable<OpenFile['conflict']> = {
  kind: 'conflict-editable',
  conflictKind: 'both_modified',
  conflictStatus: 'unresolved',
  conflictStatusSource: 'git'
}

function countedEntries(count: number): { entries: GitStatusEntry[]; reads: () => number } {
  let reads = 0
  const entries = Array.from({ length: count }, (_, index): GitStatusEntry => ({
    get path() {
      reads++
      return `file-${index}.ts`
    },
    status: 'modified',
    area: 'unstaged',
    conflictKind: conflict.conflictKind,
    conflictStatus: conflict.conflictStatus,
    conflictStatusSource: conflict.conflictStatusSource
  }))
  return { entries, reads: () => reads }
}

describe('open conflict status indexing', () => {
  it.each([true, false])(
    'skips status rows without eligible open conflicts (complete=%s)',
    (complete) => {
      const { entries, reads } = countedEntries(10_000)
      const files = [
        openFile(),
        openFile({ worktreeId: 'folder:other', conflict }),
        openFile({ mode: 'conflict-review', conflict }),
        openFile({ mode: 'check-details', conflict })
      ]

      for (let refresh = 0; refresh < 10; refresh++) {
        expect(reconcileOpenFilesForStatus(files, 'wt', entries, complete)).toBe(files)
      }
      expect(reads()).toBe(0)
    }
  )

  it('builds one index for all open conflicts and rebuilds it on the next snapshot', () => {
    const { entries, reads } = countedEntries(1_000)
    const files = Array.from({ length: 100 }, (_, index) =>
      openFile({ id: `file-${index}`, relativePath: `file-${index}.ts`, conflict })
    )
    expect(reconcileOpenFilesForStatus(files, 'wt', entries, true)).toBe(files)
    expect(reads()).toBe(1_000)

    const resolved: GitStatusEntry = {
      path: 'file-0.ts',
      status: 'modified',
      area: 'unstaged',
      conflictKind: 'both_modified',
      conflictStatus: 'resolved_locally',
      conflictStatusSource: 'session'
    }
    const updated = reconcileOpenFilesForStatus(files, 'wt', [...entries, resolved], true)
    expect(reads()).toBe(2_000)
    expect(updated[0].conflict?.conflictStatus).toBe('resolved_locally')
    expect(updated[1]).toBe(files[1])
  })
})
