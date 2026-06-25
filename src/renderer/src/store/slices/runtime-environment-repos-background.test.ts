import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpcMock = vi.fn()

vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    callRuntimeRpc: (...args: unknown[]) => callRuntimeRpcMock(...args)
  }
})

describe('fetchRuntimeEnvironmentRepos background option', () => {
  beforeEach(() => {
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock.mockImplementation((_target: unknown, method: string) => {
      if (method === 'repo.list') {
        return Promise.resolve({ repos: [] })
      }
      if (method === 'project.list') {
        return Promise.resolve({ projects: [] })
      }
      if (method === 'projectHostSetup.list') {
        return Promise.resolve({ setups: [] })
      }
      return Promise.resolve({})
    })
    // Why: assertProjectHostSetupRuntimeCapability calls window.api.runtimeEnvironments.call
    // directly for the status probe — mock it with a valid protocol version and capability.
    const runtimeEnvironmentCallMock = vi.fn().mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-1',
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2,
        capabilities: ['project-host-setup.v1']
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    ;(globalThis as { window?: unknown }).window = {
      api: { runtimeEnvironments: { call: runtimeEnvironmentCallMock } }
    }
  })

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
    vi.restoreAllMocks()
  })

  it('forwards background:true to repo.list/project.list/projectHostSetup.list', async () => {
    const { createTestStore } = await import('./store-test-helpers')
    const store = createTestStore()
    await store.getState().fetchRuntimeEnvironmentRepos('env-1', { background: true })

    const repoListCall = callRuntimeRpcMock.mock.calls.find((c) => c[1] === 'repo.list')
    const projectListCall = callRuntimeRpcMock.mock.calls.find((c) => c[1] === 'project.list')
    const setupListCall = callRuntimeRpcMock.mock.calls.find(
      (c) => c[1] === 'projectHostSetup.list'
    )
    expect(repoListCall?.[3]).toMatchObject({ background: true })
    expect(projectListCall?.[3]).toMatchObject({ background: true })
    expect(setupListCall?.[3]).toMatchObject({ background: true })
  })

  it('defaults to foreground (background undefined) when no option is given', async () => {
    const { createTestStore } = await import('./store-test-helpers')
    const store = createTestStore()
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    const repoListCall = callRuntimeRpcMock.mock.calls.find((c) => c[1] === 'repo.list')
    expect(repoListCall?.[3]?.background).toBeUndefined()
  })
})
