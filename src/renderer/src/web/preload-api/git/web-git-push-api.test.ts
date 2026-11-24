import { afterEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  callRuntimeResult: vi.fn(async () => ({ ok: true }))
}))
vi.mock('../../runtime/client/web-runtime-calls', () => ({
  callRuntimeResult: runtime.callRuntimeResult
}))
vi.mock('../workspaces/web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: async () => ({ id: 'wt-1' }),
  resolveRuntimeFilePath: async (filePath: string) => filePath
}))

import { createGitApi } from './web-git-api'

afterEach(() => {
  runtime.callRuntimeResult.mockClear()
})

// The web client used to drop forceWithLease, so Force Push after a rebase ran as a plain push the
// remote rejected. It now forwards the flag, and the host pushes with --force-with-lease.
it('forwards Force Push as a force-with-lease push to the paired host', async () => {
  await createGitApi().push!({ worktreePath: '/repo', forceWithLease: true })

  expect(runtime.callRuntimeResult).toHaveBeenCalledWith(
    'git.push',
    expect.objectContaining({ forceWithLease: true })
  )
})

it('keeps an ordinary web Push a plain push', async () => {
  await createGitApi().push!({ worktreePath: '/repo' })

  expect(runtime.callRuntimeResult).toHaveBeenCalledWith(
    'git.push',
    expect.not.objectContaining({ forceWithLease: true })
  )
})
