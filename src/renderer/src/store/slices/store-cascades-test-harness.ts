import { vi, type Mock } from 'vitest'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'

export type StoreCascadesMockApi = {
  worktrees: {
    list: Mock
    create: Mock
    remove: Mock
    forceDeletePreservedBranch: Mock
    updateMeta: Mock
  }
  repos: { list: Mock; add: Mock; remove: Mock; update: Mock; pickFolder: Mock }
  pty: { kill: Mock }
  gh: { prForBranch: Mock; issue: Mock }
  settings: { get: Mock; set: Mock }
  runtimeEnvironments: { call: Mock }
  cache: { getGitHub: Mock; setGitHub: Mock }
}

/** window.api double shared by the store cascade suites; installs itself on globalThis. */
export function createStoreCascadesMockApi(): StoreCascadesMockApi {
  const mockApi: StoreCascadesMockApi = {
    worktrees: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
      updateMeta: vi.fn().mockResolvedValue({})
    },
    repos: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({}),
      pickFolder: vi.fn().mockResolvedValue(null)
    },
    pty: {
      kill: vi.fn().mockResolvedValue(undefined)
    },
    gh: {
      prForBranch: vi.fn().mockResolvedValue(null),
      issue: vi.fn().mockResolvedValue(null)
    },
    settings: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined)
    },
    runtimeEnvironments: {
      call: vi.fn()
    },
    cache: {
      getGitHub: vi.fn().mockResolvedValue(null),
      setGitHub: vi.fn().mockResolvedValue(undefined)
    }
  }

  // @ts-expect-error -- mock
  globalThis.window = { api: mockApi }
  return mockApi
}

/** Runtime RPC default for the sleep suites: compat probes pass through, terminal.sleep reports a clean stop. */
export function applySleepRuntimeRpcDefault(mockApi: StoreCascadesMockApi): void {
  mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
    Promise.resolve(
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
        id: 'rpc-default',
        ok: true,
        result:
          args.method === 'terminal.sleep'
            ? {
                stopped: 0,
                stoppedPtyIds: [],
                livePtyIds: [],
                postStopVerified: true
              }
            : {},
        _meta: { runtimeId: 'remote-runtime' }
      }
    )
  )
}
