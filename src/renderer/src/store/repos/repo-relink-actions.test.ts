import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { RepoPathStatusEntry } from '../../../../shared/repo-path-status'
import type * as RuntimeRpcClient from '../../runtime/runtime-rpc-client'
import { createTestStore } from '../slices/store-test-helpers'

const { callRuntimeRpcMock, supportsCapabilityMock } = vi.hoisted(() => ({
  callRuntimeRpcMock: vi.fn(),
  supportsCapabilityMock: vi.fn()
}))

vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: callRuntimeRpcMock,
  runtimeEnvironmentSupportsCapability: supportsCapabilityMock,
  assertRuntimeEnvironmentCapability: async () => undefined
}))

const localRepo: Repo = {
  id: 'repo-1',
  path: '/old/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 0,
  executionHostId: 'local'
}
const runtimeRepo: Repo = { ...localRepo, id: 'repo-2', executionHostId: 'runtime:env' }

function stubApi(api: Record<string, unknown>): void {
  vi.stubGlobal('window', { api: { repos: api } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  callRuntimeRpcMock.mockReset()
  supportsCapabilityMock.mockReset()
})

describe('repo relink store actions', () => {
  it('merges local and runtime path statuses and replaces each source wholesale', async () => {
    const missing: RepoPathStatusEntry = {
      repoId: 'repo-1',
      hostId: 'local',
      path: '/old/app',
      status: { state: 'missing', reason: 'not-found' }
    }
    const getPathStatuses = vi.fn().mockResolvedValue([missing])
    stubApi({ getPathStatuses })
    supportsCapabilityMock.mockResolvedValue(true)
    callRuntimeRpcMock.mockResolvedValue({
      statuses: [{ ...missing, repoId: 'repo-2', status: { state: 'present' } }]
    })
    const store = createTestStore()
    store.setState({ repos: [localRepo, runtimeRepo] })

    await store.getState().refreshRepoPathStatuses({ force: true })

    expect(getPathStatuses).toHaveBeenCalledWith({ force: true })
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env' },
      'repo.pathStatuses',
      { force: true },
      expect.anything()
    )
    expect(Object.values(store.getState().repoPathStatuses)).toEqual([
      missing,
      // The host answers for its own repos as local; the client files them under the runtime.
      expect.objectContaining({ repoId: 'repo-2', hostId: 'runtime:env' })
    ])

    getPathStatuses.mockResolvedValue([])
    await store.getState().refreshRepoPathStatuses()
    expect(Object.keys(store.getState().repoPathStatuses)).toHaveLength(1)
  })

  it('leaves statuses of a host that cannot answer untouched', async () => {
    stubApi({ getPathStatuses: vi.fn().mockRejectedValue(new Error('ipc gone')) })
    const store = createTestStore()
    const entry: RepoPathStatusEntry = {
      repoId: 'repo-1',
      hostId: 'local',
      path: '/old/app',
      status: { state: 'missing', reason: 'not-found' }
    }
    store.setState({ repos: [localRepo], repoPathStatuses: { 'repo-1': entry } })
    await store.getState().refreshRepoPathStatuses()
    expect(store.getState().repoPathStatuses).toEqual({ 'repo-1': entry })
  })

  it('relinks a local repo through repos.update and clears its status', async () => {
    const update = vi.fn().mockResolvedValue({ ...localRepo, path: '/new/app' })
    stubApi({ update })
    const store = createTestStore()
    store.setState({ repos: [localRepo] })
    await store
      .getState()
      .refreshRepoPathStatuses()
      .catch(() => undefined)

    const outcome = await store.getState().relinkRepo('repo-1', '/new/app', { hostId: 'local' })

    expect(update).toHaveBeenCalledWith({
      repoId: 'repo-1',
      hostId: 'local',
      updates: { path: '/new/app' }
    })
    expect(outcome).toMatchObject({ ok: true, repo: { path: '/new/app' } })
    expect(store.getState().repos[0]?.path).toBe('/new/app')
  })

  it('returns the coded refusal from an IPC-wrapped error', async () => {
    stubApi({
      update: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'repos:update': Error: repo_relink_identity_unverified: no shared remote"
          )
        )
    })
    const store = createTestStore()
    store.setState({ repos: [localRepo] })
    expect(await store.getState().relinkRepo('repo-1', '/new/app', { force: false })).toEqual({
      ok: false,
      code: 'repo_relink_identity_unverified',
      message: 'no shared remote'
    })
  })

  it('relinks a runtime repo on its server with the force flag', async () => {
    callRuntimeRpcMock.mockResolvedValue({ repo: { ...runtimeRepo, path: '/new/app' } })
    stubApi({})
    const store = createTestStore()
    store.setState({ repos: [runtimeRepo] })
    const outcome = await store
      .getState()
      .relinkRepo('repo-2', '/new/app', { hostId: 'runtime:env', force: true })
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env' },
      'repo.update',
      { repo: 'repo-2', updates: { path: '/new/app' }, forcePath: true },
      expect.anything()
    )
    expect(outcome).toMatchObject({ ok: true, repo: { executionHostId: 'runtime:env' } })
  })
})
