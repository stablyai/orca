import { expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { createTestStore } from './store-test-helpers'

function compatibleStatus(runtimeId: string) {
  return {
    ok: true,
    result: {
      runtimeId,
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId }
  }
}

it('does not persist a stale overlapping runtime switch', async () => {
  let resolveFirst!: (value: unknown) => void
  const firstStatus = new Promise((resolve) => (resolveFirst = resolve))
  const persistPreference = vi.fn(({ environmentId }: { environmentId: string }) =>
    Promise.resolve({ activeRuntimeEnvironmentId: environmentId })
  )
  vi.stubGlobal('window', {
    api: {
      settings: { setActiveRuntimeEnvironmentPreference: persistPreference },
      runtimeEnvironments: {
        getStatus: vi.fn(({ selector }: { selector: string }) =>
          selector === 'env-a' ? firstStatus : Promise.resolve(compatibleStatus('runtime-b'))
        ),
        call: vi.fn().mockResolvedValue({
          ok: true,
          result: { settings: { worktreeVisibilityDefaults: { external: 'hide' } } },
          _meta: { runtimeId: 'runtime-b' }
        })
      }
    }
  })
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId: null } as never,
    fetchRepos: vi.fn().mockResolvedValue(undefined),
    fetchAllWorktrees: vi.fn().mockResolvedValue(undefined),
    fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined),
    fetchBrowserSessionProfiles: vi.fn().mockResolvedValue(undefined)
  })

  const first = store.getState().setActiveRuntimeEnvironmentPreference('env-a')
  await store.getState().setActiveRuntimeEnvironmentPreference('env-b')
  resolveFirst(compatibleStatus('runtime-a'))
  await first

  expect(persistPreference).toHaveBeenCalledOnce()
  expect(persistPreference).toHaveBeenCalledWith({ environmentId: 'env-b' })
})
