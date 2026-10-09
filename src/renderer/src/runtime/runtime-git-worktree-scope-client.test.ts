// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE } from '../../../shared/git-stage-worktree-scope'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn(), bulkStage: vi.fn() }))

vi.mock('./runtime-rpc-client', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))

import { stageRuntimeGitWorktreeScope } from './runtime-git-working-tree-client'

const REMOTE = {
  settings: { activeRuntimeEnvironmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

beforeEach(() => {
  mocks.callRuntimeRpc.mockReset()
  mocks.bulkStage.mockReset()
  Object.assign(window, { api: { git: { bulkStage: mocks.bulkStage } } })
})

describe('stageRuntimeGitWorktreeScope', () => {
  it('sends no paths, so an older runtime that strips the scope stages nothing', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, stagedScope: 'all' })

    await stageRuntimeGitWorktreeScope(REMOTE, 'all')

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'git.bulkStage',
      { worktree: 'id:wt-1', filePaths: [], scope: 'all' },
      { timeoutMs: 15_000 }
    )
  })

  it('rejects a reply from an older runtime that carries no receipt', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true })

    await expect(stageRuntimeGitWorktreeScope(REMOTE, 'all')).rejects.toThrow(
      GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE
    )
  })

  it('passes the scope with no paths through local IPC', async () => {
    mocks.bulkStage.mockResolvedValue(undefined)

    await stageRuntimeGitWorktreeScope(
      { ...REMOTE, settings: { activeRuntimeEnvironmentId: null }, connectionId: 'ssh-1' },
      'tracked'
    )

    expect(mocks.bulkStage).toHaveBeenCalledWith({
      worktreePath: '/repo',
      filePaths: [],
      connectionId: 'ssh-1',
      scope: 'tracked'
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
