import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getRepoSlugCached } from './smart-workspace-repo-slug'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: vi.fn()
}))

const repoSlug = vi.fn()

// @ts-expect-error focused preload mock
globalThis.window = { api: { gh: { repoSlug } } }

function runtimeSource(environmentId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'github',
    projectId: 'project-1',
    hostId: `runtime:${environmentId}`,
    repoId: 'repo-1'
  }
}

describe('SmartWorkspaceNameField repository slug routing', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset()
    repoSlug.mockReset()
  })

  it('resolves runtime-owned repos on their runtime and scopes the cache by runtime', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ owner: 'acme', repo: 'widgets', host: 'github.one.test' })
      .mockResolvedValueOnce({ owner: 'acme', repo: 'widgets', host: 'github.two.test' })
    const cache = new Map()
    const repo = { id: 'repo-1', path: '/workspace/widgets' }

    await expect(getRepoSlugCached(repo, runtimeSource('one'), cache)).resolves.toMatchObject({
      host: 'github.one.test'
    })
    await expect(getRepoSlugCached(repo, runtimeSource('one'), cache)).resolves.toMatchObject({
      host: 'github.one.test'
    })
    await expect(getRepoSlugCached(repo, runtimeSource('two'), cache)).resolves.toMatchObject({
      host: 'github.two.test'
    })

    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'one' },
      'github.repoSlug',
      { repo: 'repo-1' },
      { timeoutMs: 30_000 }
    )
    expect(repoSlug).not.toHaveBeenCalled()
  })
})
