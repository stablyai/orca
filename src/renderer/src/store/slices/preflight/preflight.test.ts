import { describe, expect, it, vi } from 'vitest'
import type { PreflightStatus } from '../../../../../preload/api/preflight-api'
import type { Repo } from '../../../../../shared/repo-types'

import '../../../../../shared/constants'
import type { AppState } from '../../types'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { resetRendererAppPlatformCacheForTests } from '@/app-shell/platform/renderer-app-platform'

const preflightCheck = vi.fn()
const callRuntimeRpc = vi.fn()
const platformGet = vi.fn(() => ({ platform: 'linux' }))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-cache', () => ({
  clearRecentRuntimeCompatibilityFailure: vi.fn(),
  clearRuntimeCompatibilityCache: vi.fn()
}))

globalThis.window = {
  api: {
    preflight: {
      check: preflightCheck,
      detectAgents: vi.fn().mockResolvedValue([]),
      refreshAgents: vi.fn().mockResolvedValue({
        agents: [],
        addedPathSegments: [],
        shellHydrationOk: false,
        pathSource: 'sync_seed_only',
        pathFailureReason: 'spawn_error'
      }),
      detectRemoteAgents: vi.fn().mockResolvedValue([])
    },
    platform: {
      get: platformGet
    }
  } as unknown as Window['api']
} as Window & typeof globalThis

function resetPreflightMocks(): void {
  preflightCheck.mockReset()
  callRuntimeRpc.mockReset()
  platformGet.mockReset().mockReturnValue({ platform: 'linux' })
  resetRendererAppPlatformCacheForTests()
}

function makeStatus(glabInstalled: boolean): PreflightStatus {
  return {
    git: { installed: true },
    gh: { installed: true, authenticated: true },
    glab: { installed: glabInstalled, authenticated: glabInstalled }
  }
}

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return {
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createPreflightSlice', () => {
  it('invalidates an in-flight result when its runtime session ends', async () => {
    resetPreflightMocks()
    const stale = deferred<PreflightStatus>()
    preflightCheck.mockReturnValueOnce(stale.promise)
    const store = createTestStore()

    const request = store.getState().refreshPreflightStatus()
    store.getState().invalidatePreflightStatus()
    stale.resolve(makeStatus(true))
    await request

    expect(store.getState().preflightStatus).toBeNull()
    expect(store.getState().preflightStatusChecked).toBe(false)
    expect(store.getState().preflightStatusContextKey).toBeNull()
  })

  it('clears checked status immediately when refreshing a different local context', async () => {
    resetPreflightMocks()
    const host = deferred<PreflightStatus>()
    const wsl = deferred<PreflightStatus>()
    preflightCheck.mockReturnValueOnce(host.promise).mockReturnValueOnce(wsl.promise)
    const store = createTestStore()

    const first = store.getState().refreshPreflightStatus()
    host.resolve(makeStatus(true))
    await first
    expect(store.getState().preflightStatusChecked).toBe(true)

    store.setState({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    } as Partial<AppState>)
    const second = store.getState().refreshPreflightStatus()

    expect(store.getState().preflightStatus).toBeNull()
    expect(store.getState().preflightStatusChecked).toBe(false)
    expect(store.getState().preflightStatusLoading).toBe(true)

    wsl.resolve(makeStatus(false))
    await second
    expect(store.getState().preflightStatus?.glab?.installed).toBe(false)
  })
})
