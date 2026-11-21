import { afterEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  callRuntimeResult: vi.fn(async () => ({ outcome: 'not_rebasing' }))
}))
vi.mock('../../runtime/client/web-runtime-calls', () => ({
  callRuntimeResult: runtime.callRuntimeResult
}))
vi.mock('../workspaces/web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: async () => ({ id: 'wt-1' })
}))

import { createWebGitRebaseApi } from './web-git-rebase-api'

afterEach(() => {
  runtime.callRuntimeResult.mockClear()
})

it('gives a web Continue the same 120 s budget as the desktop runtime client', async () => {
  await createWebGitRebaseApi().continueRebase({ worktreePath: '/repo', action: 'continue' })

  expect(runtime.callRuntimeResult).toHaveBeenCalledWith(
    'git.continueRebase',
    expect.objectContaining({ action: 'continue' }),
    120_000
  )
})
