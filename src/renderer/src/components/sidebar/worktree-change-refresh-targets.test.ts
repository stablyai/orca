import { describe, expect, it } from 'vitest'
import { makePRRefreshWorktree } from '@/store/slices/github-slice-test-harness'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  WORKTREE_CHANGE_SUMMARY_STALE_MS,
  selectWorktreeChangeRefreshTargets
} from './worktree-change-refresh-targets'

const NOW = 1_000_000

function worktree(id: string, overrides: Parameters<typeof makePRRefreshWorktree>[0] = {}) {
  return makePRRefreshWorktree({ id, path: `/repo/${id}`, ...overrides })
}

function select(args: Partial<Parameters<typeof selectWorktreeChangeRefreshTargets>[0]>) {
  return selectWorktreeChangeRefreshTargets({
    visibleWorktrees: [],
    activeWorktreeId: null,
    activeExecutionHostId: null,
    lastReadAtByIdentity: new Map(),
    signaledIdentities: new Set(),
    now: NOW,
    isProtectedPath: () => false,
    ...args
  }).map((target) => (target.hostId ? `${target.hostId}|${target.id}` : target.id))
}

describe('selectWorktreeChangeRefreshTargets', () => {
  it('reads signaled checkouts first, then unread ones, then the oldest stale ones', () => {
    const fresh = worktree('fresh')
    const stale = worktree('stale')
    const staler = worktree('staler')
    const unread = worktree('unread')
    const signaled = worktree('signaled')
    const lastReadAtByIdentity = new Map([
      [getWorktreeHostIdentity(fresh), NOW - 1_000],
      [getWorktreeHostIdentity(stale), NOW - WORKTREE_CHANGE_SUMMARY_STALE_MS],
      [getWorktreeHostIdentity(staler), NOW - WORKTREE_CHANGE_SUMMARY_STALE_MS * 2],
      [getWorktreeHostIdentity(signaled), NOW - 1_000]
    ])

    expect(
      select({
        visibleWorktrees: [fresh, stale, staler, unread, signaled],
        lastReadAtByIdentity,
        signaledIdentities: new Set([getWorktreeHostIdentity(signaled)])
      })
    ).toEqual(['signaled', 'unread', 'staler', 'stale'])
  })

  it('skips the active checkout only on its own host', () => {
    const localTwin = worktree('shared-id')
    const remoteTwin = worktree('shared-id', { hostId: 'ssh:box' })

    expect(
      select({
        visibleWorktrees: [localTwin, remoteTwin],
        activeWorktreeId: 'shared-id',
        activeExecutionHostId: 'local'
      })
    ).toEqual(['ssh:box|shared-id'])
    expect(
      select({
        visibleWorktrees: [localTwin, remoteTwin],
        activeWorktreeId: 'shared-id',
        activeExecutionHostId: 'ssh:box'
      })
    ).toEqual(['shared-id'])
  })

  it('never reads protected paths passively', () => {
    expect(
      select({
        visibleWorktrees: [worktree('container'), worktree('plain')],
        isProtectedPath: (path) => path.endsWith('container')
      })
    ).toEqual(['plain'])
  })
})
