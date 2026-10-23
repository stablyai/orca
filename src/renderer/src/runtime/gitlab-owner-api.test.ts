import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.supports
}))

import { gitLabApiFor } from './gitlab-owner-api'
import { forgeCredentialTarget, forgeOwnerHostIdForWorkspace } from './forge-credential-target'

const glListIssues = vi.fn()

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ items: [] })
  rpc.supports.mockReset().mockResolvedValue(true)
  glListIssues.mockReset().mockResolvedValue({ items: [] })
  vi.stubGlobal('window', { api: { gl: { listIssues: glListIssues } } })
})

describe('gitLabApiFor', () => {
  it('reads a server-owned repo on that server', async () => {
    const selector = {
      repoPath: '/work/app',
      repoId: 'server-repo',
      repoOwnerExecutionHostId: 'runtime:owner-server'
    }
    await gitLabApiFor(selector).listIssues({ ...selector, state: 'opened' })

    expect(glListIssues).not.toHaveBeenCalled()
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'gitlab.listIssues',
      expect.objectContaining({ repo: 'id:server-repo', state: 'opened' }),
      { timeoutMs: 30_000 }
    )
  })

  it("loads a server-owned repo's reviewers from that server", async () => {
    const reviewer = {
      id: 7,
      username: 'ana',
      name: 'Ana',
      avatarUrl: 'https://gitlab.example.com/ana.png'
    }
    rpc.call.mockResolvedValue([reviewer])
    const selector = {
      repoPath: '/work/app',
      repoId: 'server-repo',
      repoOwnerExecutionHostId: 'runtime:owner-server'
    }

    await expect(gitLabApiFor(selector).listAssignableUsers(selector)).resolves.toEqual([reviewer])
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'gitlab.listAssignableUsers',
      expect.objectContaining({ repo: 'id:server-repo' }),
      { timeoutMs: 30_000 }
    )
  })

  it('offers no reviewers from a server older than the reviewer RPC', async () => {
    rpc.call.mockRejectedValue(
      Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
    )
    const selector = {
      repoPath: '/work/app',
      repoId: 'server-repo',
      repoOwnerExecutionHostId: 'runtime:owner-server'
    }

    await expect(gitLabApiFor(selector).listAssignableUsers(selector)).resolves.toEqual([])
  })

  it('surfaces other reviewer lookup failures', async () => {
    rpc.call.mockRejectedValue(Object.assign(new Error('glab failed'), { code: 'runtime_error' }))
    const selector = {
      repoPath: '/work/app',
      repoId: 'server-repo',
      repoOwnerExecutionHostId: 'runtime:owner-server'
    }

    await expect(gitLabApiFor(selector).listAssignableUsers(selector)).rejects.toThrow(
      'glab failed'
    )
  })

  it.each(['ssh:devbox', 'local'])(
    'uses this computer for a %s repo',
    async (repoOwnerExecutionHostId) => {
      const selector = { repoPath: '/work/app', repoId: 'repo', repoOwnerExecutionHostId }
      await gitLabApiFor(selector).listIssues(selector)

      expect(rpc.call).not.toHaveBeenCalled()
      expect(glListIssues).toHaveBeenCalledOnce()
    }
  )

  it('lets a task source name the host and the server-side repo id', async () => {
    const selector = {
      repoPath: '/work/app',
      repoId: 'renderer-id',
      repoOwnerExecutionHostId: 'local',
      sourceContext: {
        kind: 'task-source' as const,
        provider: 'gitlab' as const,
        projectId: 'p',
        hostId: 'runtime:owner-server' as const,
        repoId: 'server-side-id'
      }
    }
    await gitLabApiFor(selector).listIssues(selector)

    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'gitlab.listIssues',
      expect.objectContaining({ repo: 'id:server-side-id' }),
      expect.anything()
    )
  })

  it('rejects instead of guessing when the owner is unresolved', async () => {
    const selector = {
      repoPath: '/work/app',
      repoOwnerExecutionHostId: 'runtime:unresolved-owner'
    }

    expect(() => forgeCredentialTarget(selector)).toThrow()
    await expect(gitLabApiFor(selector).listIssues(selector)).rejects.toThrow(
      'The machine that owns this repository is not known yet'
    )
    expect(rpc.call).not.toHaveBeenCalled()
    expect(glListIssues).not.toHaveBeenCalled()
  })

  it('sends an SSH workspace behind a server to that server, a direct SSH one to this computer', async () => {
    const repo = { executionHostId: 'runtime:owner-server' as const }
    const nested = forgeOwnerHostIdForWorkspace(repo, {
      hostId: 'ssh:devbox',
      runtimeOwnerEnvironmentId: 'owner-server'
    })
    const selector = { repoPath: '/work/app', repoId: 'repo', repoOwnerExecutionHostId: nested }
    await gitLabApiFor(selector).listIssues(selector)

    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'gitlab.listIssues',
      expect.anything(),
      expect.anything()
    )
    expect(forgeOwnerHostIdForWorkspace({ connectionId: 'devbox' }, { hostId: 'ssh:devbox' })).toBe(
      'ssh:devbox'
    )
    expect(forgeOwnerHostIdForWorkspace({ connectionId: 'devbox' }, null)).toBe('ssh:devbox')
  })
})

it('cancels a server preview without aborting another dialog or changing its owner', async () => {
  const signals = new Map<number, AbortSignal>()
  rpc.call.mockImplementation((_target, _method, params, options) => {
    signals.set(params.iid, options.signal)
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  })
  const selector = {
    repoPath: '/work/app',
    repoId: 'server-repo',
    repoOwnerExecutionHostId: 'runtime:owner-server'
  }
  const api = gitLabApiFor(selector)
  const first = api.workItemDetails({
    ...selector,
    iid: 1,
    type: 'issue',
    requestToken: 'one',
    includeImages: true
  })
  const second = api.workItemDetails({ ...selector, iid: 2, type: 'issue', requestToken: 'two' })
  const firstRejected = expect(first).rejects.toThrow('cancelled')
  await api.cancelWorkItemDetails({ requestToken: 'one' })
  await firstRejected
  expect(signals.get(1)?.aborted).toBe(true)
  expect(signals.get(2)?.aborted).toBe(false)
  expect(rpc.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'owner-server' },
    'gitlab.workItemDetails',
    expect.objectContaining({ repo: 'id:server-repo', iid: 1, includeImages: true }),
    expect.objectContaining({ signal: signals.get(1) })
  )
  expect(rpc.call.mock.calls[0][2]).not.toHaveProperty('requestToken')
  expect(rpc.call.mock.calls[0][2]).not.toHaveProperty('repoOwnerExecutionHostId')
  const secondRejected = expect(second).rejects.toThrow('cancelled')
  await api.cancelWorkItemDetails({ requestToken: 'two' })
  await secondRejected
})
