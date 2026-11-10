import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  activate: vi.fn()
}))

const store = vi.hoisted(() => ({
  useAppStore: {
    getState: () => ({
      repos: [{ id: 'repo', kind: 'git' }],
      getKnownWorktreeById: (id: string) =>
        id === 'repo::/work/feature'
          ? { id, repoId: 'repo', branch: 'feature/login', displayName: 'Login' }
          : undefined,
      createWorktree: mocks.createWorktree
    })
  }
}))
vi.mock('@/store', () => store)
vi.mock('@/store/index', () => store)
vi.mock('@/lib/workspace/ownership/resolve-owner', () => ({
  resolveOwner: () => ({ kind: 'unresolved' })
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activate
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

import { runNativeChatWorktreeFork } from './native-chat-worktree-fork'

describe('runNativeChatWorktreeFork', () => {
  beforeEach(() => {
    mocks.createWorktree.mockReset().mockResolvedValue({
      worktree: { id: 'repo::/work/login-fork', path: '/work/login-fork' }
    })
    mocks.activate.mockReset()
  })

  it.each([
    ['main', undefined],
    ['current', 'feature/login']
  ] as const)(
    'starts a %s-branch fork from %s and opens the chat in it',
    async (base, baseBranch) => {
      const request = vi
        .fn()
        .mockResolvedValue({ chat: { sessionId: 's', executionHostId: 'local' } })
      await expect(
        runNativeChatWorktreeFork({
          sourceWorktreeId: 'repo::/work/feature',
          base,
          agent: 'claude',
          throughItemId: 'reply-1',
          request
        })
      ).resolves.toBe(true)
      expect(mocks.createWorktree.mock.calls[0]?.slice(0, 3)).toEqual([
        'repo',
        'login-fork',
        baseBranch
      ])
      expect(mocks.activate).toHaveBeenCalledWith('repo::/work/login-fork', {
        sidebarRevealBehavior: 'auto'
      })
      expect(request).toHaveBeenCalledWith('reply-1', undefined, {
        worktreeId: 'repo::/work/login-fork'
      })
    }
  )
})
