import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRateLimitSlice, selectAccountOwnerRateLimits } from './rate-limits'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

function createRateLimitStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) =>
    createRateLimitSlice(...(args as Parameters<typeof createRateLimitSlice>))
  ) as unknown as StoreApi<AppState>
}

function remoteStateFixture(marker: string): RateLimitState {
  return {
    ...createRateLimitStore().getState().rateLimits,
    claude: {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: marker,
      status: 'ok'
    }
  }
}

function setActiveEnvironment(store: StoreApi<AppState>, environmentId: string | null): void {
  store.setState({
    settings: { activeRuntimeEnvironmentId: environmentId } as AppState['settings']
  })
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
})

describe('createRateLimitSlice', () => {
  it('initializes Antigravity usage with a stable pending key', () => {
    const store = createRateLimitStore()

    expect(store.getState().rateLimits.antigravity).toBeNull()
  })

  it('applies a remote snapshot only while its environment owns accounts', () => {
    const store = createRateLimitStore()
    setActiveEnvironment(store, 'env-1')

    store.getState().setRemoteRateLimits('env-1', remoteStateFixture('current-owner'))
    expect(store.getState().remoteRateLimits?.environmentId).toBe('env-1')

    // Why: a slow frame from the previous owner must not label the new owner's usage.
    store.getState().setRemoteRateLimits('env-0', remoteStateFixture('stale-owner'))
    expect(store.getState().remoteRateLimits?.state.claude?.error).toBe('current-owner')
  })

  it('selects the remote snapshot for the active environment and falls back to local', () => {
    const store = createRateLimitStore()
    setActiveEnvironment(store, 'env-1')

    // No remote snapshot yet: local state keeps the surface populated.
    expect(selectAccountOwnerRateLimits(store.getState())).toBe(store.getState().rateLimits)

    const remote = remoteStateFixture('remote')
    store.getState().setRemoteRateLimits('env-1', remote)
    expect(selectAccountOwnerRateLimits(store.getState())).toBe(remote)

    // Back to local accounts: the lingering remote snapshot must not win.
    setActiveEnvironment(store, null)
    expect(selectAccountOwnerRateLimits(store.getState())).toBe(store.getState().rateLimits)

    store.getState().clearRemoteRateLimits()
    expect(store.getState().remoteRateLimits).toBeNull()
  })

  it('refreshRemoteAccountUsage forces a server usage refresh and stores the snapshot', async () => {
    const store = createRateLimitStore()
    setActiveEnvironment(store, 'env-1')
    const remote = remoteStateFixture('forced')
    callRuntimeRpc.mockResolvedValue({ rateLimits: remote })

    await store.getState().refreshRemoteAccountUsage('env-1')

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'accounts.list',
      { refreshUsage: true },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(store.getState().remoteRateLimits?.state).toBe(remote)
  })

  it('refreshRemoteAccountUsage keeps prior state on RPC failure and null snapshots', async () => {
    const store = createRateLimitStore()
    setActiveEnvironment(store, 'env-1')
    const remote = remoteStateFixture('kept')
    store.getState().setRemoteRateLimits('env-1', remote)

    callRuntimeRpc.mockRejectedValueOnce(new Error('offline'))
    await store.getState().refreshRemoteAccountUsage('env-1')
    expect(store.getState().remoteRateLimits?.state).toBe(remote)

    callRuntimeRpc.mockResolvedValueOnce({ rateLimits: null })
    await store.getState().refreshRemoteAccountUsage('env-1')
    expect(store.getState().remoteRateLimits?.state).toBe(remote)
  })
})
