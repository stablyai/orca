import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY,
  GIT_CARRY_WORKING_TREE_CHANGES_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  callRuntimeResult: vi.fn(),
  getRemoteRuntimeStatus: vi.fn(),
  resolveRuntimeWorktreeByPath: vi.fn()
}))

vi.mock('./web-runtime-calls', () => ({
  callRuntimeResult: mocks.callRuntimeResult,
  getRemoteRuntimeStatus: mocks.getRemoteRuntimeStatus
}))
vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: mocks.resolveRuntimeWorktreeByPath
}))

const { carryWorkingTreeChangesOverRuntime } = await import('./web-git-carry-api')

const WORKTREES: Record<string, { id: string }> = {
  '/workspace/repo': { id: 'wt-1' },
  '/workspace/repo-child': { id: 'wt-2' }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRemoteRuntimeStatus.mockResolvedValue({
    capabilities: [GIT_CARRY_WORKING_TREE_CHANGES_RUNTIME_CAPABILITY]
  })
  mocks.resolveRuntimeWorktreeByPath.mockImplementation(async (path: string) => {
    const worktree = WORKTREES[path]
    if (!worktree) {
      throw new Error(`No runtime worktree owns ${path}`)
    }
    return worktree
  })
  mocks.callRuntimeResult.mockResolvedValue({ ok: true, trackedChanges: true, untrackedCopied: 1 })
})

describe('carryWorkingTreeChangesOverRuntime', () => {
  it('carries by worktree selector when the paired host advertises the capability', async () => {
    await expect(
      carryWorkingTreeChangesOverRuntime('/workspace/repo', '/workspace/repo-child')
    ).resolves.toEqual({ ok: true, trackedChanges: true, untrackedCopied: 1 })
    expect(mocks.callRuntimeResult).toHaveBeenCalledWith(
      'git.carryWorkingTreeChanges',
      { sourceWorktree: 'id:wt-1', targetWorktree: 'id:wt-2' },
      120_000
    )
  })

  it('refuses honestly without calling a paired host that predates the method', async () => {
    mocks.getRemoteRuntimeStatus.mockResolvedValue({ capabilities: ['runtime.status.compat.v1'] })

    await expect(
      carryWorkingTreeChangesOverRuntime('/workspace/repo', '/workspace/repo-child')
    ).resolves.toEqual({
      ok: false,
      reason: 'apply_failed',
      detail: GIT_CARRY_WORKING_TREE_CHANGES_UPDATE_REQUIRED_MESSAGE
    })
    expect(mocks.callRuntimeResult).not.toHaveBeenCalled()
  })

  it('refuses honestly when the host status cannot be read', async () => {
    mocks.getRemoteRuntimeStatus.mockRejectedValue(new Error('offline'))

    await expect(
      carryWorkingTreeChangesOverRuntime('/workspace/repo', '/workspace/repo-child')
    ).resolves.toMatchObject({ ok: false, reason: 'apply_failed' })
    expect(mocks.callRuntimeResult).not.toHaveBeenCalled()
  })

  it('refuses honestly when a path belongs to no runtime worktree', async () => {
    await expect(
      carryWorkingTreeChangesOverRuntime('/workspace/repo', '/elsewhere/child')
    ).resolves.toEqual({
      ok: false,
      reason: 'apply_failed',
      detail: 'No runtime worktree owns /elsewhere/child'
    })
    expect(mocks.callRuntimeResult).not.toHaveBeenCalled()
  })
})
