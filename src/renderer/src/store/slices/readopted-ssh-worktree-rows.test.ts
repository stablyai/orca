import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { reconcileReadoptedSshWorktreesByRepo } from './readopted-ssh-worktree-rows'

const readoption = {
  oldTargetId: 'ssh-old',
  newTargetId: 'ssh-new',
  repoIds: ['repo-1']
}

describe('reconcileReadoptedSshWorktreesByRepo', () => {
  it('moves an old-host row onto the exact re-adopted host', () => {
    const result = reconcileReadoptedSshWorktreesByRepo(
      { 'repo-1': [{ id: 'worktree-1', hostId: 'ssh:ssh-old' }] },
      [readoption]
    )

    expect(result['repo-1']).toEqual([{ id: 'worktree-1', hostId: 'ssh:ssh-new' }])
  })

  it('keeps the already-fetched new-host row when both hosts are present', () => {
    const result = reconcileReadoptedSshWorktreesByRepo(
      {
        'repo-1': [
          { id: 'worktree-1', hostId: 'ssh:ssh-old', label: 'stale' },
          { id: 'worktree-1', hostId: 'ssh:ssh-new', label: 'authoritative' }
        ]
      },
      [readoption]
    )

    expect(result['repo-1']).toEqual([
      { id: 'worktree-1', hostId: 'ssh:ssh-new', label: 'authoritative' }
    ])
  })

  it('leaves unrelated repo and host rows untouched', () => {
    const rows: Record<string, { id: string; hostId: ExecutionHostId }[]> = {
      'repo-1': [{ id: 'other-host', hostId: 'ssh:ssh-other' }],
      'repo-2': [{ id: 'old-host', hostId: 'ssh:ssh-old' }]
    }

    expect(reconcileReadoptedSshWorktreesByRepo(rows, [readoption])).toBe(rows)
  })
})
