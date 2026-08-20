import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from './host-qualified-identity'

const WORKTREE_ID = 'repo-1::/work/orca'

describe('worktree host identity', () => {
  it('separates two hosts that publish the same id', () => {
    expect(getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: 'local' })).not.toBe(
      getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: 'ssh:build-box' })
    )
  })

  it('gives an unqualified row its own bucket', () => {
    expect(getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: undefined })).not.toBe(
      getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: 'local' })
    )
  })

  // Why this matters: the store index recovers the workspace id from its own key
  // rather than re-reading `worktree.id`, so a host id containing the separator
  // would silently truncate every id in the index.
  it('round-trips the id back out for every host shape', () => {
    const hostIds = [
      undefined,
      'local',
      toSshExecutionHostId('build-box'),
      // Real SSH aliases carry '@' and ':'; runtime ids are uuids.
      toSshExecutionHostId('deploy@10.0.0.4:2222'),
      toRuntimeExecutionHostId('03ef704c-b180-4b10-998d-e28fbd5de9a3')
    ] as const

    for (const hostId of hostIds) {
      expect(getWorktreeIdFromHostIdentity(composeWorktreeHostIdentity(hostId, WORKTREE_ID))).toBe(
        WORKTREE_ID
      )
    }
  })

  it('round-trips a workspace id that itself contains the separator', () => {
    // A workspace id is a repo id plus a filesystem path, so it may contain
    // anything; only the host half has to be separator-free.
    const awkwardId = 'repo-1::/work/a|b/orca'

    expect(
      getWorktreeIdFromHostIdentity(
        composeWorktreeHostIdentity(toSshExecutionHostId('build-box'), awkwardId)
      )
    ).toBe(awkwardId)
  })

  it('keeps a host id free of the separator by construction', () => {
    // encodeURIComponent escapes '|' as %7C, which is what makes the split exact.
    expect(toSshExecutionHostId('we|rd')).not.toContain('|')
    expect(toRuntimeExecutionHostId('we|rd')).not.toContain('|')
  })
})
