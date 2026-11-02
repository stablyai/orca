import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.supports
}))

import { gitLabApiFor } from './gitlab-owner-api'
import { forgeCredentialTarget } from './forge-credential-target'

const glListIssues = vi.fn()

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ items: [] })
  rpc.supports.mockReset().mockResolvedValue(true)
  glListIssues.mockReset().mockResolvedValue({ items: [] })
  vi.stubGlobal('window', { api: { gl: { listIssues: glListIssues } } })
})

describe('gitLabApiFor', () => {
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
})
