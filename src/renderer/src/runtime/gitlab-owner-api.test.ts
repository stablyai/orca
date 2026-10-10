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
