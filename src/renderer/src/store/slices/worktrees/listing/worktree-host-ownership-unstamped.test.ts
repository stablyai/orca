import { beforeEach, describe, expect, it } from 'vitest'
import {
  getUnstampedNonLocalRowCount,
  resetUnstampedNonLocalRowCountForTest
} from '@/lib/unstamped-non-local-row-counter'
import { worktreeMatchesHost } from './worktree-host-ownership'

describe('worktreeMatchesHost unstamped non-local rows', () => {
  beforeEach(() => resetUnstampedNonLocalRowCountForTest())

  it.each([
    ['stamped SSH row', { hostId: 'ssh:t' as const }, 'ssh:t' as const, true, true, 0],
    ['stamped server row', { runtimeOwnerEnvironmentId: 'e' }, 'runtime:e' as const, true, true, 0],
    ['unstamped row claimed by local', {}, 'local' as const, true, true, 0],
    ['unstamped row claimed by SSH', {}, 'ssh:t' as const, true, true, 1],
    ['unstamped row claimed by a server', {}, 'runtime:e' as const, true, true, 1],
    ['unstamped row refused by SSH', {}, 'ssh:t' as const, false, false, 0],
    ['unstamped row, no hint, SSH', {}, 'ssh:t' as const, undefined, false, 0],
    ['unstamped row, no hint, local', {}, 'local' as const, undefined, true, 0]
  ])('%s', (_name, row, hostId, unhostedWorktreesMatchHost, matches, count) => {
    expect(worktreeMatchesHost(row, hostId, { unhostedWorktreesMatchHost })).toBe(matches)
    expect(getUnstampedNonLocalRowCount()).toBe(count)
  })
})
