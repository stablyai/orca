import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from './git-status-types'
import { getConflictResolutions } from './source-control-entry-actions'

function conflict(overrides: Partial<GitStatusEntry>): GitStatusEntry {
  return {
    path: 'a.txt',
    area: 'unstaged',
    status: 'modified',
    conflictKind: 'both_modified',
    conflictStatus: 'unresolved',
    ...overrides
  }
}

describe('getConflictResolutions', () => {
  it('offers both sides of a delete/modify conflict while the surviving file is present', () => {
    expect(getConflictResolutions(conflict({ conflictKind: 'deleted_by_us' }))).toEqual([
      'keep_file',
      'keep_deletion'
    ])
  })

  it('offers only the deletion once the worktree file is gone', () => {
    expect(
      getConflictResolutions(conflict({ conflictKind: 'deleted_by_them', status: 'deleted' }))
    ).toEqual(['keep_deletion'])
    expect(
      getConflictResolutions(conflict({ conflictKind: 'both_modified', status: 'deleted' }))
    ).toEqual(['keep_deletion'])
  })

  it('marks content conflicts resolved as edited', () => {
    expect(getConflictResolutions(conflict({}))).toEqual(['mark_resolved'])
  })

  it('offers nothing for resolved rows or rows inside a submodule the parent cannot stage', () => {
    expect(getConflictResolutions(conflict({ conflictStatus: 'resolved_locally' }))).toEqual([])
    expect(getConflictResolutions(conflict({ submoduleRoot: 'sub' }))).toEqual([])
  })
})
