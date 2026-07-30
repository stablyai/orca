import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, realpathNativeMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(),
  realpathNativeMock: vi.fn<(path: string) => string>()
}))

// Why: the fault semantics (exists-but-unresolvable, one-side-stat-able) cannot be produced
// with real fixtures on stock hosts; deterministic fs stubs pin them instead.
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  realpathSync: Object.assign(vi.fn(), { native: realpathNativeMock })
}))

import { hookCwdContradictsWorktreeAfterLocalResolve } from './agent-hook-cwd-attribution'

const WORKTREE = 'repo-1::/data/workspace-a'
const FOREIGN_CWD = '/data/session-b'

describe('hookCwdContradictsWorktreeAfterLocalResolve local-resolve semantics', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    realpathNativeMock.mockReset()
  })

  it('still refuses when both sides resolve to disjoint directories', () => {
    existsSyncMock.mockReturnValue(true)
    realpathNativeMock.mockImplementation((path) => path)
    expect(hookCwdContradictsWorktreeAfterLocalResolve(WORKTREE, FOREIGN_CWD)).toBe(true)
  })

  it('keeps when a local path exists but cannot be resolved', () => {
    // Why: EPERM-style mounts or a directory deleted mid-check — the alias question is
    // unanswerable for a path this host owns, and unclear keeps.
    existsSyncMock.mockReturnValue(true)
    realpathNativeMock.mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    expect(hookCwdContradictsWorktreeAfterLocalResolve(WORKTREE, FOREIGN_CWD)).toBe(false)
  })

  it('keeps when only one side is stat-able locally', () => {
    // Why: a recorded worktree spelling that cannot be stat-ed on the host that owns it
    // (renamed, deleted, whitespace-mangled in transit) cannot prove a foreign session.
    existsSyncMock.mockImplementation((path) => path === FOREIGN_CWD)
    realpathNativeMock.mockImplementation((path) => path)
    expect(hookCwdContradictsWorktreeAfterLocalResolve(WORKTREE, FOREIGN_CWD)).toBe(false)

    existsSyncMock.mockImplementation((path) => path === '/data/workspace-a')
    expect(hookCwdContradictsWorktreeAfterLocalResolve(WORKTREE, FOREIGN_CWD)).toBe(false)
  })

  it('still refuses when neither side exists locally, preserving the foreign-host verdict', () => {
    existsSyncMock.mockReturnValue(false)
    expect(hookCwdContradictsWorktreeAfterLocalResolve(WORKTREE, FOREIGN_CWD)).toBe(true)
    expect(realpathNativeMock).not.toHaveBeenCalled()
  })
})
