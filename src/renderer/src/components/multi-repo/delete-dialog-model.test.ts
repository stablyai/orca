import { describe, expect, it } from 'vitest'
import type {
  MultiRepoDeleteInspection,
  MultiRepoDeleteResult
} from '../../../../shared/multi-repo-workspace'
import {
  applyDeleteResult,
  buildDeleteRows,
  countFailed,
  countRemaining,
  enterConfirmsDelete,
  getForcedMemberIds,
  markRemoving,
  toggleForceMember
} from './delete-dialog-model'

const inspection: MultiRepoDeleteInspection = {
  folderWorkspaceId: 'f1',
  rootPath: '/w/f1',
  rootOwnedByOrca: true,
  members: [
    {
      memberId: 'a',
      repoId: 'repo-a',
      state: 'ready',
      worktreeId: 'wt-a',
      worktreeExists: true,
      dirtyCount: 0,
      unpublishedCommitCount: 0,
      willKeepBranch: false
    },
    {
      memberId: 'b',
      repoId: 'repo-b',
      state: 'ready',
      worktreeId: 'wt-b',
      worktreeExists: true,
      dirtyCount: 3,
      unpublishedCommitCount: 1,
      willKeepBranch: true
    },
    {
      memberId: 'c',
      repoId: 'repo-c',
      state: 'ready',
      worktreeId: 'wt-c',
      worktreeExists: true,
      dirtyCount: null,
      unpublishedCommitCount: null,
      willKeepBranch: null
    }
  ]
}
const labels = new Map([
  ['a', { label: 'api', branchName: 'flow' }],
  ['b', { label: 'web', branchName: 'flow' }]
])

describe('buildDeleteRows', () => {
  it('sorts risky rows first and never reads an unknown check as clean', () => {
    const rows = buildDeleteRows(inspection, labels)
    expect(rows.map((row) => [row.label, row.risky, row.dirtyCount])).toEqual([
      ['web', true, 3],
      ['repo-c', true, null],
      ['api', false, 0]
    ])
    expect(rows[1].branchKept).toBeNull()
  })

  it('keeps a member risky when only the unpublished-commit check failed', () => {
    const [row] = buildDeleteRows(
      {
        ...inspection,
        members: [
          {
            memberId: 'd',
            repoId: 'repo-d',
            state: 'ready',
            worktreeId: 'wt-d',
            worktreeExists: true,
            dirtyCount: 0,
            unpublishedCommitCount: null,
            willKeepBranch: true
          }
        ]
      },
      labels
    )
    expect(row.risky).toBe(true)
    expect(enterConfirmsDelete([row])).toBe(false)
  })

  it('lets Enter confirm only a workspace with nothing at risk', () => {
    expect(enterConfirmsDelete(buildDeleteRows(inspection, labels))).toBe(false)
    expect(enterConfirmsDelete(buildDeleteRows(inspection, labels).filter((r) => !r.risky))).toBe(
      true
    )
  })
})

describe('force consent', () => {
  it('sends only ticked risky repos that still hold a worktree', () => {
    const rows = buildDeleteRows(inspection, labels)
    let forced = toggleForceMember(new Set(), 'b')
    forced = toggleForceMember(forced, 'a')
    expect(getForcedMemberIds(rows, forced)).toEqual(['b'])
    expect(getForcedMemberIds(rows, toggleForceMember(forced, 'b'))).toEqual([])
  })
})

describe('applyDeleteResult', () => {
  const result: MultiRepoDeleteResult = {
    folderWorkspaceId: 'f1',
    workspaceRemoved: false,
    remainingMemberCount: 1,
    members: [
      { memberId: 'a', status: 'removed' },
      { memberId: 'b', status: 'failed', code: 'dirty', message: 'has uncommitted changes' },
      { memberId: 'c', status: 'removed', preservedBranch: 'flow' }
    ]
  }

  it('marks removed and failed repos and keeps the failure reason', () => {
    const rows = applyDeleteResult(markRemoving(buildDeleteRows(inspection, labels)), result)
    expect(
      rows.map((row) => [row.label, row.phase, row.failureMessage, row.preservedBranch])
    ).toEqual([
      ['web', 'failed', 'has uncommitted changes', null],
      ['repo-c', 'removed', null, 'flow'],
      ['api', 'removed', null, null]
    ])
    expect(countFailed(rows)).toBe(1)
    expect(countRemaining(rows)).toBe(1)
  })

  it('never retries a removed repo and treats a repo the host no longer lists as removed', () => {
    const first = applyDeleteResult(markRemoving(buildDeleteRows(inspection, labels)), result)
    const retrying = markRemoving(first)
    expect(retrying.find((row) => row.label === 'api')?.phase).toBe('removed')
    const second = applyDeleteResult(retrying, {
      folderWorkspaceId: 'f1',
      workspaceRemoved: true,
      remainingMemberCount: 0,
      members: [{ memberId: 'b', status: 'removed' }]
    })
    expect(second.every((row) => row.phase === 'removed')).toBe(true)
  })
})
