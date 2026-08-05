// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GitHubViewerLoginScope } from './task-page-github-viewer-login'

const { callRuntimeRpcMock, viewerMock } = vi.hoisted(() => ({
  callRuntimeRpcMock: vi.fn(),
  viewerMock: vi.fn()
}))

vi.mock('../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: callRuntimeRpcMock
}))

import { loadGitHubViewerLogin, useGitHubViewerLogin } from './task-page-github-viewer-login'

function scope(
  repoId: string,
  hostId: string,
  host = 'github.com',
  runtimeRepoId = repoId
): GitHubViewerLoginScope {
  return {
    repoId,
    repoPath: `/workspace/${repoId}`,
    sourceContext: {
      kind: 'task-source',
      provider: 'github',
      projectId: `project-${repoId}`,
      hostId: hostId as ExecutionHostId,
      repoId: runtimeRepoId,
      providerIdentity: { provider: 'github', owner: 'acme', repo: repoId, host }
    }
  }
}

describe('loadGitHubViewerLogin', () => {
  beforeEach(() => {
    callRuntimeRpcMock.mockReset()
    viewerMock.mockReset()
    vi.stubGlobal('window', { api: { gh: { viewer: viewerMock } } })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes local and runtime repos to their owning execution hosts', async () => {
    viewerMock.mockResolvedValue({ login: 'octocat', email: null })
    callRuntimeRpcMock.mockResolvedValue({ login: 'OCTOCAT', email: null })

    await expect(
      loadGitHubViewerLogin([
        scope('local-repo', 'local'),
        scope('runtime-repo', 'runtime:env-1', 'ghe.example.com', 'remote-repo-1')
      ])
    ).resolves.toBe('octocat')

    expect(viewerMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'local-repo', repoPath: '/workspace/local-repo' })
    )
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.viewer',
      { repo: 'id:remote-repo-1', host: 'ghe.example.com' },
      { timeoutMs: 15_000 }
    )
  })

  it('returns null unless every selected auth scope resolves and agrees', async () => {
    viewerMock
      .mockResolvedValueOnce({ login: 'octocat', email: null })
      .mockResolvedValueOnce({ login: 'hubot', email: null })

    await expect(
      loadGitHubViewerLogin([scope('one', 'local'), scope('two', 'ssh:ssh-1')])
    ).resolves.toBeNull()
  })

  it('treats a rejected viewer scope as unresolved', async () => {
    viewerMock.mockRejectedValue(new Error('unavailable'))

    await expect(loadGitHubViewerLogin([scope('one', 'local')])).resolves.toBeNull()
  })

  it('deduplicates concurrent renderer requests for the same selected repos', async () => {
    viewerMock.mockResolvedValue({ login: 'octocat', email: null })
    const scopes = [scope('one', 'local'), scope('two', 'ssh:ssh-1')]

    await expect(
      Promise.all([loadGitHubViewerLogin(scopes), loadGitHubViewerLogin(scopes)])
    ).resolves.toEqual(['octocat', 'octocat'])

    expect(viewerMock).toHaveBeenCalledTimes(2)
  })

  it('does not poll a mounted viewer login', async () => {
    vi.useFakeTimers()
    viewerMock
      .mockResolvedValueOnce({ login: 'octocat', email: null })
      .mockResolvedValueOnce({ login: 'hubot', email: null })
    const scopes = [scope('one', 'local')]
    const { result, unmount } = renderHook(() => useGitHubViewerLogin(true, scopes, 0))
    await act(async () => {})

    expect(result.current).toBe('octocat')
    expect(viewerMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(result.current).toBe('octocat')
    expect(viewerMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    unmount()
  })

  it('refreshes after an explicit Tasks refresh', async () => {
    viewerMock
      .mockResolvedValueOnce({ login: 'octocat', email: null })
      .mockResolvedValueOnce({ login: 'hubot', email: null })
    const scopes = [scope('one', 'local')]
    const { result, rerender } = renderHook(
      ({ refreshKey }) => useGitHubViewerLogin(true, scopes, refreshKey),
      { initialProps: { refreshKey: 0 } }
    )
    await act(async () => {})

    expect(result.current).toBe('octocat')

    rerender({ refreshKey: 1 })
    await act(async () => {})

    expect(result.current).toBe('hubot')
    expect(viewerMock).toHaveBeenCalledTimes(2)
    expect(viewerMock).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
  })

  it('refreshes once when the app returns to the foreground', async () => {
    viewerMock
      .mockResolvedValueOnce({ login: 'octocat', email: null })
      .mockResolvedValueOnce({ login: 'hubot', email: null })
    const scopes = [scope('one', 'local')]
    const { result } = renderHook(() => useGitHubViewerLogin(true, scopes, 0))
    await act(async () => {})

    expect(result.current).toBe('octocat')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current).toBe('hubot')
    expect(viewerMock).toHaveBeenCalledTimes(2)
    expect(viewerMock).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
  })
})
