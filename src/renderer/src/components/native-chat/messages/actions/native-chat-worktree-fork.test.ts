import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  activate: vi.fn(),
  toastError: vi.fn()
}))

const store = vi.hoisted(() => ({
  useAppStore: {
    getState: () => ({
      repos: [{ id: 'repo', kind: 'git' }],
      getKnownWorktreeById: (id: string) =>
        id === 'repo::/work/feature'
          ? {
              id,
              repoId: 'repo',
              branch: 'feature/login',
              displayName: 'Login',
              path: '/work/feature'
            }
          : undefined,
      worktreesByRepo: {
        repo: [
          { path: '/work/feature', branch: 'refs/heads/feature/login' },
          { path: '/work/login-fork', branch: 'refs/heads/me/login-fork' }
        ]
      },
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
vi.mock('@/runtime/native-chat/orchestration/structured-session-orca-session-id', () => ({
  resolveStructuredSessionOrcaSessionId: async () => 'orca:source-chat'
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

import { nativeChatWorktreeForkPlan, runNativeChatWorktreeFork } from './native-chat-worktree-fork'

describe('runNativeChatWorktreeFork', () => {
  beforeEach(() => {
    mocks.createWorktree.mockReset().mockResolvedValue({
      worktree: { id: 'repo::/work/login-fork', path: '/work/login-fork' }
    })
    mocks.activate.mockReset()
    mocks.toastError.mockReset()
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

  it('closes once the worktree exists, even when the fork fails, so a retry makes no second one', async () => {
    const request = vi.fn().mockResolvedValue({})
    await expect(
      runNativeChatWorktreeFork({
        sourceWorktreeId: 'repo::/work/feature',
        base: 'main',
        agent: 'claude',
        throughItemId: 'reply-1',
        request
      })
    ).resolves.toBe(true)
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
  })

  it('says so when the worktree exists but the chat fork never started', async () => {
    await runNativeChatWorktreeFork({
      sourceWorktreeId: 'repo::/work/feature',
      base: 'main',
      agent: 'claude',
      throughItemId: 'reply-1',
      request: vi.fn().mockResolvedValue(undefined)
    })
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The worktree was created, but the chat could not be forked into it.'
    )
  })

  it('names a second fork Fork 2 and nests every fork under its source', async () => {
    expect(nativeChatWorktreeForkPlan('repo::/work/feature')).toEqual({
      name: 'login-fork-2',
      displayName: 'Fork 2 of Login',
      folder: '/work'
    })
    await runNativeChatWorktreeFork({
      sourceWorktreeId: 'repo::/work/feature',
      base: 'main',
      agent: 'claude',
      throughItemId: 'reply-1',
      request: vi.fn().mockResolvedValue({}),
      name: 'login-fork-2',
      displayName: 'Fork 2 of Login'
    })
    const call = mocks.createWorktree.mock.calls[0]!
    expect([call[1], call[6]]).toEqual(['login-fork-2', 'Fork 2 of Login'])
    expect(call.at(-1)).toMatchObject({ parentWorktreeId: 'repo::/work/feature' })
  })

  it('starts a subagent on its task in the background, told to report back to this chat', async () => {
    const request = vi.fn().mockResolvedValue({})
    await runNativeChatWorktreeFork({
      sourceWorktreeId: 'repo::/work/feature',
      base: 'main',
      agent: 'claude',
      throughItemId: 'reply-1',
      request,
      mode: 'subagent',
      subagent: {
        task: 'Try the reverse order',
        target: { kind: 'local' },
        sessionId: 'claude_source',
        label: 'Login chat'
      }
    })
    expect(mocks.activate).not.toHaveBeenCalled()
    const [, side, destination] = request.mock.calls[0]!
    expect(destination).toEqual({ worktreeId: 'repo::/work/login-fork' })
    expect(side.question).toContain('Try the reverse order')
    expect(side.question).toContain('orca orchestration send --to orca:source-chat')
  })

  it('opens a fork from one of your messages with that message left as a draft', async () => {
    const request = vi.fn().mockResolvedValue({})
    await runNativeChatWorktreeFork({
      sourceWorktreeId: 'repo::/work/feature',
      base: 'main',
      agent: 'claude',
      throughItemId: 'reply-before-message',
      request,
      draft: 'Use the reverse order instead'
    })
    expect(request).toHaveBeenCalledWith(
      'reply-before-message',
      undefined,
      { worktreeId: 'repo::/work/login-fork' },
      'Use the reverse order instead'
    )
  })
})
