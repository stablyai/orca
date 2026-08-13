// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getConnectionId: vi.fn<(worktreeId: string | null) => string | null | undefined>(() => null),
  isWorktreeConnectionResolved: vi.fn<(worktreeId: string | null) => boolean>(() => true),
  resolvePaneWslDistro: vi.fn<(...args: unknown[]) => string | null>(() => null),
  reauthenticateForTarget: vi.fn(async () => ({ accounts: [], activeAccountId: null })),
  storeState: {
    allWorktrees: () => [{ id: 'worktree-1', path: '/repo' }]
  }
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => mocks.storeState }
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: (worktreeId: string | null) => mocks.getConnectionId(worktreeId),
  isWorktreeConnectionResolved: (worktreeId: string | null) =>
    mocks.isWorktreeConnectionResolved(worktreeId)
}))

vi.mock('../terminal-pane/terminal-pane-wsl-distro', () => ({
  resolvePaneWslDistro: (...args: unknown[]) => mocks.resolvePaneWslDistro(...args)
}))

import { useNativeChatAccountReauth } from './use-native-chat-account-reauth'

describe('useNativeChatAccountReauth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConnectionId.mockReturnValue(null)
    mocks.isWorktreeConnectionResolved.mockReturnValue(true)
    mocks.resolvePaneWslDistro.mockReturnValue(null)
    mocks.reauthenticateForTarget.mockResolvedValue({ accounts: [], activeAccountId: null })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { claudeAccounts: { reauthenticateForTarget: mocks.reauthenticateForTarget } }
    })
  })

  it('is undefined for a non-Claude agent', () => {
    const { result } = renderHook(() => useNativeChatAccountReauth('codex', 'worktree-1', null))
    expect(result.current).toBeUndefined()
  })

  it('is undefined without a worktreeId', () => {
    const { result } = renderHook(() => useNativeChatAccountReauth('claude', undefined, null))
    expect(result.current).toBeUndefined()
  })

  it('is undefined for a runtime-owned pane (ephemeral cloud VM), even with no SSH connectionId', () => {
    // Regression: a `runtime:`-owned pane has connectionId: null (indistinguishable
    // from local to getConnectionId) but must still be excluded.
    const { result } = renderHook(() =>
      useNativeChatAccountReauth('claude', 'worktree-1', 'runtime-env-1')
    )
    expect(result.current).toBeUndefined()
    expect(mocks.getConnectionId).not.toHaveBeenCalled()
  })

  it('is undefined while connection ownership has not resolved yet', () => {
    mocks.isWorktreeConnectionResolved.mockReturnValue(false)
    const { result } = renderHook(() => useNativeChatAccountReauth('claude', 'worktree-1', null))
    expect(result.current).toBeUndefined()
  })

  it('is undefined for an SSH-remote worktree', () => {
    mocks.getConnectionId.mockReturnValue('ssh-target-1')
    const { result } = renderHook(() => useNativeChatAccountReauth('claude', 'worktree-1', null))
    expect(result.current).toBeUndefined()
  })

  it('reauthenticates the host target for a local Claude pane', async () => {
    const { result } = renderHook(() => useNativeChatAccountReauth('claude', 'worktree-1', null))
    expect(result.current).toBeInstanceOf(Function)

    await expect(result.current?.()).resolves.toEqual({ ok: true })
    expect(mocks.reauthenticateForTarget).toHaveBeenCalledWith({ runtime: 'host' })
  })

  it('reauthenticates the WSL target when the worktree resolves to a distro', async () => {
    mocks.resolvePaneWslDistro.mockReturnValue('Ubuntu')
    const { result } = renderHook(() => useNativeChatAccountReauth('claude', 'worktree-1', null))

    await expect(result.current?.()).resolves.toEqual({ ok: true })
    expect(mocks.reauthenticateForTarget).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })

  it('returns a descriptive failure instead of throwing when reauthentication rejects', async () => {
    mocks.reauthenticateForTarget.mockRejectedValue(
      new Error('No Claude account is configured for this pane yet.')
    )
    const { result } = renderHook(() => useNativeChatAccountReauth('claude', 'worktree-1', null))

    await expect(result.current?.()).resolves.toEqual({
      ok: false,
      message: 'No Claude account is configured for this pane yet.'
    })
  })
})
