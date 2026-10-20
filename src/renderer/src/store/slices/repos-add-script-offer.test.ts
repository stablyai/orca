import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type { Repo } from '../../../../shared/repo-types'
import type { RepositoryAddScriptPreview } from '../../../../shared/repository-add-script-types'
import { createTestStore } from './store-test-helpers'

const mocks = vi.hoisted(() => ({
  resolveRequest: vi.fn(),
  offer: vi.fn(),
  reposAdd: vi.fn(),
  callRuntimeRpc: vi.fn(),
  findProjectProfiles: vi.fn()
}))

vi.mock('@/runtime/runtime-repository-add-script', () => ({
  resolveRuntimeRepositoryAddScriptRequest: mocks.resolveRequest
}))

vi.mock('@/store/repository-add-script-prompt', () => ({
  offerRepositoryAddScript: mocks.offer
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return { ...actual, callRuntimeRpc: mocks.callRuntimeRpc }
})

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-added',
    path: '/workspace/added',
    displayName: 'added',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makePreview(
  overrides: Partial<RepositoryAddScriptPreview> = {}
): RepositoryAddScriptPreview {
  return {
    token: 'token-added',
    hostId: 'local',
    hostLabel: 'This computer',
    repoId: 'repo-added',
    path: '/workspace/added',
    target: { kind: 'native', cwd: '/workspace/added' },
    script: 'echo added',
    scriptHash: 'hash-added',
    ...overrides
  }
}

describe('repo add repository add-script offer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveRequest.mockResolvedValue(undefined)
    mocks.findProjectProfiles.mockResolvedValue({ projects: [] })
    vi.stubGlobal('window', {
      api: {
        repos: { add: mocks.reposAdd },
        orcaProfiles: { findProjectProfiles: mocks.findProjectProfiles }
      }
    })
  })

  it('omits the opt-in and never offers when the host does not accept one', async () => {
    const repo = makeRepo()
    mocks.reposAdd.mockResolvedValue({ repo })
    const store = createTestStore()

    await expect(store.getState().addRepoPath(repo.path)).resolves.toEqual({
      ...repo,
      executionHostId: 'local'
    })

    expect(mocks.reposAdd).toHaveBeenCalledWith({ path: repo.path, kind: 'git' })
    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('never opts a folder registration in and does not probe the host', async () => {
    const repo = makeRepo({ kind: 'folder' })
    mocks.reposAdd.mockResolvedValue({ repo })
    const store = createTestStore()

    await store.getState().addRepoPath(repo.path, 'folder')

    expect(mocks.resolveRequest).not.toHaveBeenCalled()
    expect(mocks.reposAdd).toHaveBeenCalledWith({ path: repo.path, kind: 'folder' })
  })

  it('sends a paired repo.add without the field when the server predates the capability', async () => {
    const repo = makeRepo({ id: 'runtime-repo', path: '/srv/runtime-repo' })
    mocks.callRuntimeRpc.mockResolvedValue({ repo })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never
    })

    await store.getState().addRepoPath(repo.path)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'repo.add',
      { path: repo.path, kind: 'git' },
      { timeoutMs: 15_000 }
    )
    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('offers a matching preview once and keeps it out of the repo store', async () => {
    const repo = makeRepo()
    const preview = makePreview()
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.reposAdd.mockResolvedValue({ repo, repositoryAddScriptPreview: preview })
    const store = createTestStore()

    await store.getState().addRepoPath(repo.path)

    expect(mocks.reposAdd).toHaveBeenCalledWith({
      path: repo.path,
      kind: 'git',
      repositoryAddScriptPreview: { hostId: 'local' }
    })
    expect(mocks.offer).toHaveBeenCalledTimes(1)
    expect(mocks.offer).toHaveBeenCalledWith(preview)
    const stored = store.getState().repos
    expect(stored).toHaveLength(1)
    expect(stored[0]).not.toHaveProperty('repositoryAddScriptPreview')
    expect(JSON.stringify(stored)).not.toContain(preview.token)
  })

  it('does not offer a preview addressed to another host', async () => {
    const repo = makeRepo()
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.reposAdd.mockResolvedValue({
      repo,
      repositoryAddScriptPreview: makePreview({ hostId: 'runtime:env-1' })
    })
    const store = createTestStore()

    await store.getState().addRepoPath(repo.path)

    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('does not offer a preview addressed to another repo', async () => {
    const repo = makeRepo()
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.reposAdd.mockResolvedValue({
      repo,
      repositoryAddScriptPreview: makePreview({ repoId: 'repo-other' })
    })
    const store = createTestStore()

    await store.getState().addRepoPath(repo.path)

    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('still offers a preview the host minted when a catalog refresh already stored the row', async () => {
    const repo = makeRepo()
    const preview = makePreview()
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.reposAdd.mockResolvedValue({
      repo,
      repositoryAddScriptPreview: preview
    })
    const store = createTestStore()
    store.setState({ repos: [{ ...repo, executionHostId: 'local' }] })

    await store.getState().addRepoPath(repo.path)

    // Why: only the host mints a preview, so the client's dedupe flag must not suppress it.
    expect(mocks.offer).toHaveBeenCalledWith(preview)
  })

  it('offers the preview returned beside a paired-host repo.add result', async () => {
    const repo = makeRepo({ id: 'runtime-repo', path: '/srv/runtime-repo' })
    const preview = makePreview({
      hostId: 'runtime:env-1',
      repoId: repo.id,
      path: repo.path
    })
    mocks.resolveRequest.mockResolvedValue({ hostId: 'runtime:env-1' })
    mocks.callRuntimeRpc.mockResolvedValue({ repo, repositoryAddScriptPreview: preview })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never
    })

    await store.getState().addRepoPath(repo.path)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'repo.add',
      {
        path: repo.path,
        kind: 'git',
        repositoryAddScriptPreview: { hostId: 'runtime:env-1' }
      },
      { timeoutMs: 15_000 }
    )
    expect(mocks.offer).toHaveBeenCalledWith(preview)
    expect(store.getState().repos).toEqual([{ ...repo, executionHostId: 'runtime:env-1' }])
  })
})
