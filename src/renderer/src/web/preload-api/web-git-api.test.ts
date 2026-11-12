import { expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  call: vi.fn(async () => ({ repositoryStatuses: [{ path: 'child', kind: 'repository' }] })),
  abortable: vi.fn(async () => ({
    ok: true,
    result: { repositoryStatuses: [{ path: 'child', kind: 'repository' }] }
  }))
}))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: transport.call }))
vi.mock('../../runtime/rpc/calls/abortable-runtime-environment-call', () => ({
  callAbortableRuntimeEnvironment: transport.abortable
}))
vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: async () => ({ id: 'folder:project' })
}))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'server' }),
  updateEnvironmentFromResponse: () => {}
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))

import { createGitApi } from './web-git-api'

it('keeps scoped repository reads scoped through pooled and cancellable web transports', async () => {
  const git = createGitApi()
  const request = {
    worktreePath: '/project',
    repositoryPaths: ['child'],
    repositoryIntent: 'ignored' as const,
    repositoryQueryPaths: ['file.tmp']
  }
  await expect(git.status(request)).resolves.toMatchObject({
    repositoryStatuses: [{ path: 'child', kind: 'repository' }]
  })
  expect(transport.call).toHaveBeenCalledWith(
    'git.status',
    expect.objectContaining({
      worktree: 'id:folder:project',
      repositoryPaths: ['child'],
      repositoryIntent: 'ignored',
      repositoryQueryPaths: ['file.tmp']
    })
  )
  await git.status({ ...request, requestToken: 'scoped-status' })
  expect(transport.abortable).toHaveBeenCalledWith(
    'server',
    'git.status',
    expect.objectContaining({
      worktree: 'id:folder:project',
      repositoryPaths: ['child'],
      repositoryIntent: 'ignored',
      repositoryQueryPaths: ['file.tmp']
    }),
    undefined,
    expect.any(AbortSignal)
  )
})
