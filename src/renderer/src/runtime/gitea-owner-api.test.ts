import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call
}))

import { giteaApiFor } from './gitea-owner-api'
import { RuntimeRpcCallError } from './runtime-rpc-result'

const localListIssues = vi.fn()

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ items: [] })
  localListIssues.mockReset().mockResolvedValue({ items: [] })
  vi.stubGlobal('window', { api: { gitea: { listIssues: localListIssues } } })
})

describe('giteaApiFor', () => {
  it('uses the local bridge without a selector or for a local repo', async () => {
    await giteaApiFor().listIssues({ repoPath: '/work/app' })
    await giteaApiFor({ repoPath: '/work/app', repoOwnerExecutionHostId: 'local' }).listIssues({
      repoPath: '/work/app'
    })

    expect(localListIssues).toHaveBeenCalledTimes(2)
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('routes a server-owned repo through runtime RPC', async () => {
    const selector = {
      repoPath: '/work/app',
      repoId: 'server-repo',
      repoOwnerExecutionHostId: 'runtime:owner-server'
    }
    await giteaApiFor(selector).listIssues(selector)

    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'gitea.listIssues',
      expect.anything(),
      expect.anything()
    )
    expect(localListIssues).not.toHaveBeenCalled()
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
    await giteaApiFor(selector).listIssues(selector)

    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-server' },
      'gitea.listIssues',
      expect.objectContaining({ repo: 'id:server-side-id' }),
      expect.anything()
    )
  })

  it('rejects instead of guessing when the owner is unresolved', async () => {
    const selector = { repoPath: '/work/app', repoOwnerExecutionHostId: 'runtime:unresolved-owner' }

    await expect(giteaApiFor(selector).listIssues(selector)).rejects.toThrow(
      'The machine that owns this repository is not known yet'
    )
    expect(rpc.call).not.toHaveBeenCalled()
    expect(localListIssues).not.toHaveBeenCalled()
  })

  it('explains a server that predates Gitea instead of surfacing Unknown method', async () => {
    rpc.call.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'req-1',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: gitea.listPRs' },
        _meta: { runtimeId: 'old-server' }
      })
    )
    const selector = {
      repoPath: '/work/app',
      repoId: 'server-repo',
      repoOwnerExecutionHostId: 'runtime:owner-server'
    }

    await expect(giteaApiFor(selector).listPRs(selector)).rejects.toThrow(
      'This Orca server does not support Gitea yet'
    )
  })
})
