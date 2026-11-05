import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getRepoSlugCached, getRepoUpstreamCached } from './smart-workspace-repo-slug'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn()
}))

const repoSlug = vi.fn()
const repoUpstream = vi.fn()

// @ts-expect-error focused preload mock
globalThis.window = { api: { gh: { repoSlug, repoUpstream } } }

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
    repoUpstream.mockReset()
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

  it('does not permanently cache a failed GHES resolution', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ owner: 'acme', repo: 'widgets', host: 'github.acme.test' })
    const cache = new Map()
    const repo = { id: 'repo-1', path: '/workspace/widgets' }
    const source = runtimeSource('one')

    await expect(getRepoSlugCached(repo, source, cache)).resolves.toBeNull()
    await expect(getRepoSlugCached(repo, source, cache)).resolves.toMatchObject({
      host: 'github.acme.test'
    })
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('resolves runtime-owned upstream slugs on their runtime', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
      owner: 'stablyai',
      repo: 'orca',
      host: 'github.one.test'
    })
    const cache = new Map()
    const repo = { id: 'repo-1', path: '/workspace/widgets' }

    await expect(getRepoUpstreamCached(repo, runtimeSource('one'), cache)).resolves.toMatchObject({
      host: 'github.one.test'
    })
    await expect(getRepoUpstreamCached(repo, runtimeSource('one'), cache)).resolves.toMatchObject({
      host: 'github.one.test'
    })

    expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'one' },
      'github.repoUpstream',
      { repo: 'repo-1' },
      { timeoutMs: 30_000 }
    )
    expect(repoUpstream).not.toHaveBeenCalled()
  })
})
