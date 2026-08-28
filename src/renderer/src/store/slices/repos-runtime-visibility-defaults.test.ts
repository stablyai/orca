import { expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

it('hydrates a runtime owner default when refreshing its repositories', async () => {
  clearRuntimeCompatibilityCacheForTests()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: vi.fn(({ method }: { method: string }) => {
          const result =
            method === 'status.get'
              ? {
                  runtimeId: 'runtime-1',
                  graphStatus: 'ready',
                  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
                  capabilities: [WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY]
                }
              : method === 'repo.list'
                ? { repos: [] }
                : method === 'settings.get'
                  ? { settings: { worktreeVisibilityDefaults: { external: 'show' } } }
                  : method === 'project.list'
                    ? { projects: [] }
                    : { setups: [] }
          return Promise.resolve({
            ok: true,
            result,
            _meta: { runtimeId: 'runtime-1' }
          })
        })
      }
    }
  })
  const store = createTestStore()
  store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

  await store.getState().fetchRuntimeEnvironmentRepos('env-1')

  expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-1']).toEqual({
    external: 'show'
  })
  expect(store.getState().settings?.worktreeVisibilityDefaults).toEqual({ external: 'show' })
  expect(store.getState().worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId).toBe('env-1')
  expect(store.getState().worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId).toBe(
    'env-1'
  )
})

it('clears focused support when a runtime omits the default', async () => {
  clearRuntimeCompatibilityCacheForTests()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: vi.fn(({ method }: { method: string }) =>
          Promise.resolve({
            ok: true,
            result:
              method === 'status.get'
                ? {
                    runtimeId: 'runtime-1',
                    graphStatus: 'ready',
                    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
                  }
                : method === 'repo.list'
                  ? { repos: [] }
                  : { settings: {} },
            _meta: { runtimeId: 'runtime-1' }
          })
        )
      }
    }
  })
  const store = createTestStore()
  store.setState({
    settings: {
      activeRuntimeEnvironmentId: 'env-1',
      worktreeVisibilityDefaults: { external: 'show' }
    } as never,
    worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: 'env-1',
    worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: 'env-1'
  })

  await store.getState().fetchRuntimeEnvironmentRepos('env-1')

  expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-1']).toBeNull()
  expect(store.getState().settings?.worktreeVisibilityDefaults).toBeUndefined()
  expect(store.getState().worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId).toBeNull()
  expect(store.getState().worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId).toBeNull()
})

it('preserves focused support when runtime default hydration fails', async () => {
  clearRuntimeCompatibilityCacheForTests()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: vi.fn(({ method }: { method: string }) =>
          method === 'settings.get'
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({
                ok: true,
                result:
                  method === 'status.get'
                    ? {
                        runtimeId: 'runtime-1',
                        graphStatus: 'ready',
                        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
                      }
                    : { repos: [] },
                _meta: { runtimeId: 'runtime-1' }
              })
        )
      }
    }
  })
  const store = createTestStore()
  store.setState({
    settings: {
      activeRuntimeEnvironmentId: 'env-1',
      worktreeVisibilityDefaults: { external: 'show' }
    } as never,
    worktreeVisibilityDefaultsByHost: { 'runtime:env-1': { external: 'show' } },
    worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: 'env-1',
    worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: 'env-1'
  })

  await store.getState().fetchRuntimeEnvironmentRepos('env-1')

  expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-1']).toEqual({
    external: 'show'
  })
  expect(store.getState().settings?.worktreeVisibilityDefaults).toEqual({ external: 'show' })
  expect(store.getState().worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId).toBe('env-1')
  expect(store.getState().worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId).toBe(
    'env-1'
  )
})
