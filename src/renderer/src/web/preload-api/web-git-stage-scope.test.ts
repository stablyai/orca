// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE } from '../../../../shared/git-stage-worktree-scope'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: async () => ({ id: 'wt-1' }),
  resolveRuntimeFilePath: vi.fn()
}))

import { createGitApi } from './web-git-api'

describe('web client whole-worktree Stage All', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })

  it('sends the scope without paths and accepts the runtime receipt', async () => {
    callRuntimeResult.mockResolvedValue({ ok: true, stagedScope: 'all' })

    await createGitApi().bulkStage!({ worktreePath: '/repo', filePaths: ['a.ts'], scope: 'all' })

    expect(callRuntimeResult).toHaveBeenCalledWith('git.bulkStage', {
      worktree: 'id:wt-1',
      filePaths: [],
      scope: 'all'
    })
  })

  it('rejects an older runtime that staged nothing and sent no receipt', async () => {
    callRuntimeResult.mockResolvedValue({ ok: true })

    await expect(
      createGitApi().bulkStage!({ worktreePath: '/repo', filePaths: [], scope: 'all' })
    ).rejects.toThrow(GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE)
  })
})
