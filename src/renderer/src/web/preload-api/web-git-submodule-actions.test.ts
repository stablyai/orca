// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: async () => ({ id: 'wt-1' }),
  resolveRuntimeFilePath: vi.fn()
}))

import { createGitApi } from './web-git-api'

describe('web client submodule actions', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset().mockResolvedValue(undefined)
  })

  it('lists no submodules, because the runtime cannot serve them', async () => {
    await expect(createGitApi().submoduleRepos!({ worktreePath: '/repo' })).resolves.toEqual([])
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it.each(['fetch', 'pull', 'push'] as const)(
    '%s refuses a submodule instead of acting on the parent repository',
    async (action) => {
      await expect(
        createGitApi()[action]!({ worktreePath: '/repo', submodulePath: 'libs/sub' })
      ).rejects.toThrow('not available on this host')
      expect(callRuntimeResult).not.toHaveBeenCalled()
    }
  )

  it('still sends a plain pull to the runtime', async () => {
    await createGitApi().pull!({ worktreePath: '/repo' })
    expect(callRuntimeResult).toHaveBeenCalledWith('git.pull', {
      worktree: 'id:wt-1',
      pushTarget: undefined
    })
  })
})
