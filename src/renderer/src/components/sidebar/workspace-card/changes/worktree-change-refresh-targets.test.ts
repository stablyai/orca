import { describe, expect, it } from 'vitest'
import { makePRRefreshWorktree } from '@/store/github/github-slice-test-harness'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  WORKTREE_CHANGE_SUMMARY_STALE_MS,
  selectMirroredActiveWorktree,
  selectWorktreeChangeRefreshTargets
} from './worktree-change-refresh-targets'

const NOW = 1_000_000

function worktree(id: string, overrides: Parameters<typeof makePRRefreshWorktree>[0] = {}) {
  return makePRRefreshWorktree({ id, path: `/repo/${id}`, ...overrides })
}

function select(args: Partial<Parameters<typeof selectWorktreeChangeRefreshTargets>[0]>) {
  return selectWorktreeChangeRefreshTargets({
    visibleWorktrees: [],
    mirroredIdentity: null,
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

  it('skips only the mirrored copy', () => {
    const active = worktree('active')
    const other = worktree('other')

    expect(
      select({
        visibleWorktrees: [active, other],
        mirroredIdentity: getWorktreeHostIdentity(active)
      })
    ).toEqual(['other'])
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

describe('selectMirroredActiveWorktree', () => {
  it('mirrors a lone copy, treating stamped local and unstamped rows as one copy', () => {
    const unstamped = worktree('solo')
    const stamped = worktree('solo', { hostId: 'local' })

    expect(selectMirroredActiveWorktree([unstamped, stamped], 'solo', 'local')).toBe(unstamped)
  })

  it('refuses to mirror when the bare-id status could belong to a host twin', () => {
    const localTwin = worktree('shared-id')
    const remoteTwin = worktree('shared-id', { hostId: 'ssh:box' })

    expect(selectMirroredActiveWorktree([localTwin, remoteTwin], 'shared-id', 'ssh:box')).toBe(null)
  })
})
