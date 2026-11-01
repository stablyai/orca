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
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

beforeEach(() => {
  mocks.callRuntimeRpc.mockReset()
  mocks.bulkStage.mockReset()
  Object.assign(window, { api: { git: { bulkStage: mocks.bulkStage } } })
})

describe('stageRuntimeGitWorktreeScope', () => {
  it('rejects a reply from an older runtime that carries no receipt', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true })

    await expect(stageRuntimeGitWorktreeScope(REMOTE, 'all')).rejects.toThrow(
      GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE
    )
  })
})
