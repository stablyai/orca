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

describe('web client submodule reads and index actions', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset().mockResolvedValue(undefined)
  })

  const SUBMODULE_CALLS: [string, () => Promise<unknown>][] = [
    ['status', () => createGitApi().status!({ worktreePath: '/repo', submodulePath: 'libs/sub' })],
    [
      'commit',
      () =>
        createGitApi().commit!({ worktreePath: '/repo', message: 'msg', submodulePath: 'libs/sub' })
    ],
    [
      'stage',
      () =>
        createGitApi().stage!({
          worktreePath: '/repo',
          filePath: 'a.txt',
          submodulePath: 'libs/sub'
        })
    ],
    [
      'unstage',
      () =>
        createGitApi().unstage!({
          worktreePath: '/repo',
          filePath: 'a.txt',
          submodulePath: 'libs/sub'
        })
    ],
    [
      'bulkStage',
      () =>
        createGitApi().bulkStage!({
          worktreePath: '/repo',
          filePaths: ['a.txt'],
          submodulePath: 'libs/sub'
        })
    ],
    [
      'bulkUnstage',
      () =>
        createGitApi().bulkUnstage!({
          worktreePath: '/repo',
          filePaths: ['a.txt'],
          submodulePath: 'libs/sub'
        })
    ]
  ]

  it.each(SUBMODULE_CALLS)(
    '%s refuses a submodule instead of acting on the parent',
    async (_name, call) => {
      await expect(call()).rejects.toThrow('not available on this host')
      expect(callRuntimeResult).not.toHaveBeenCalled()
    }
  )

  it('still commits to the runtime when no submodule is named', async () => {
    await createGitApi().commit!({ worktreePath: '/repo', message: 'msg' })
    expect(callRuntimeResult).toHaveBeenCalledWith('git.commit', {
      worktree: 'id:wt-1',
      message: 'msg'
    })
  })
})
