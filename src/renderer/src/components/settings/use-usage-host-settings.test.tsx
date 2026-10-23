// @vitest-environment happy-dom
import { Suspense } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: vi.fn(),
  hydrate: vi.fn(),
  refresh: vi.fn(),
  state: {
    hydratePersistedUI: vi.fn(),
    fetchSettings: vi.fn(),
    rateLimits: { usageRequestPolicy: { revision: 1 } }
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: fake.rpc }))
vi.mock('sonner', () => ({ toast: { error: fake.toast } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(fake.state)
}))
import { useUsageHostSettings } from './use-usage-host-settings'

function projection(enabled: Record<string, boolean> = {}) {
  return {
    usageRequestPolicyVersion: 1,
    usageRequestEnabled: enabled,
    antigravityUsageEnabled: false
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const ownerA: RuntimeClientTarget = { kind: 'environment', environmentId: 'a' }
const ownerB: RuntimeClientTarget = { kind: 'environment', environmentId: 'b' }
const updateLocal = vi.fn()
function useModel(owner: RuntimeClientTarget) {
  return useUsageHostSettings(owner, 'host', getDefaultSettings('/test'), updateLocal)
}
beforeEach(() => {
  vi.resetAllMocks()
  fake.state.hydratePersistedUI = fake.hydrate
  fake.state.fetchSettings = fake.refresh
  fake.state.rateLimits.usageRequestPolicy.revision = 1
  fake.rpc.mockResolvedValue({ settings: projection() })
})
afterEach(cleanup)

describe('usage request host acknowledgement', () => {
  it('preserves the committed host write when a different host render suspends and is discarded', async () => {
    const write = deferred<{ settings: ReturnType<typeof projection> }>()
    const suspended = deferred<void>()
    fake.rpc
      .mockResolvedValueOnce({ settings: projection({ claude: false }) })
      .mockReturnValueOnce(write.promise)
    function Host({ owner, suspend }: { owner: RuntimeClientTarget; suspend: boolean }) {
      const model = useModel(owner)
      if (suspend) {
        throw suspended.promise
      }
      return (
        <button onClick={() => void model.requestPolicy?.update('claude', true)}>
          {String(model.requestPolicy?.enabled?.claude)}
        </button>
      )
    }
    const tree = render(
      <Suspense fallback="Loading host">
        <Host owner={ownerA} suspend={false} />
      </Suspense>
    )
    await waitFor(() => expect(tree.getByRole('button').textContent).toBe('false'))
    fireEvent.click(tree.getByRole('button'))
    tree.rerender(
      <Suspense fallback="Loading host">
        <Host owner={ownerB} suspend />
      </Suspense>
    )
    expect(tree.getByText('Loading host')).toBeDefined()
    await act(async () => {
      write.resolve({ settings: projection({ claude: true }) })
    })
    tree.rerender(
      <Suspense fallback="Loading host">
        <Host owner={ownerA} suspend={false} />
      </Suspense>
    )
    await waitFor(() => expect(tree.getByRole('button').textContent).toBe('true'))
    expect(fake.rpc).toHaveBeenCalledTimes(2)
  })
  it('keeps old or malformed hosts unknown instead of claiming requests are off', async () => {
    fake.rpc.mockResolvedValueOnce({ settings: {} })
    const hook = renderHook(() => useModel(ownerA))
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('outdated'))
    expect(hook.result.current.requestPolicy?.enabled).toBeNull()
    hook.unmount()
    fake.rpc.mockResolvedValueOnce({
      settings: { usageRequestPolicyVersion: 1, usageRequestEnabled: {} }
    })
    const malformed = renderHook(() => useModel(ownerA))
    await waitFor(() => expect(malformed.result.current.requestPolicy?.access).toBe('outdated'))
    expect(malformed.result.current.requestPolicy?.enabled).toBeNull()
  })

  it('does not publish a write that returns after switching away and back to its host', async () => {
    const write = deferred<{ settings: ReturnType<typeof projection> }>()
    const hook = renderHook(({ owner }) => useModel(owner), { initialProps: { owner: ownerA } })
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    fake.rpc.mockImplementation((_owner: unknown, method: string) =>
      method === 'settings.update' ? write.promise : Promise.resolve({ settings: projection() })
    )
    let completion: Promise<void> | undefined
    act(() => {
      completion = hook.result.current.requestPolicy?.update('claude', false)
    })
    hook.rerender({ owner: ownerB })
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    hook.rerender({ owner: ownerA })
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    await act(async () => {
      write.resolve({ settings: projection({ claude: false }) })
      await completion
    })
    expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true)
    expect(fake.toast).not.toHaveBeenCalled()
  })

  it('rejects stripped writes and leaves an unsupported host unknown', async () => {
    const hook = renderHook(() => useModel(ownerA))
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    fake.rpc.mockResolvedValueOnce({ settings: { usageRequestEnabled: {} } })
    await act(async () => {
      await hook.result.current.requestPolicy?.update('kimi', false)
    })
    expect(hook.result.current.requestPolicy?.access).toBe('outdated')
    expect(hook.result.current.requestPolicy?.enabled).toBeNull()
    expect(fake.toast).toHaveBeenCalledOnce()
    expect(updateLocal).not.toHaveBeenCalled()
  })

  it('does not acknowledge a provider value the host did not apply', async () => {
    const hook = renderHook(() => useModel(ownerA))
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    await act(async () => {
      await hook.result.current.requestPolicy?.update('zcode', false)
    })
    expect(hook.result.current.requestPolicy?.enabled?.zcode).toBe(true)
    expect(fake.toast).toHaveBeenCalledOnce()
  })

  it('uses the durable local host policy route before synchronizing Antigravity visibility', async () => {
    const persisted = deferred<{ settings: ReturnType<typeof projection> }>()
    const getUi = vi.fn(async () => ({ statusBarItems: [] }))
    Object.assign(window, { api: { ui: { get: getUi } } })
    fake.rpc
      .mockResolvedValueOnce({ settings: { ...projection(), antigravityUsageEnabled: true } })
      .mockReturnValueOnce(persisted.promise)
    const hook = renderHook(() => useModel({ kind: 'local' }))
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    let completion: Promise<void> | undefined
    act(() => {
      completion = hook.result.current.requestPolicy?.update('antigravity', false)
    })
    expect(fake.rpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'settings.update',
      { antigravityUsageEnabled: false },
      { timeoutMs: 15_000 }
    )
    expect(getUi).not.toHaveBeenCalled()
    await act(async () => {
      persisted.resolve({ settings: projection() })
      await completion
    })
    expect(getUi).toHaveBeenCalledOnce()
    expect(fake.hydrate).toHaveBeenCalledWith({ statusBarItems: [] })
    expect(updateLocal).not.toHaveBeenCalled()
    expect(fake.toast).not.toHaveBeenCalled()
  })

  it('refreshes the owning host policy when its existing usage snapshot revision changes', async () => {
    const hook = renderHook(
      ({ revision }) =>
        useUsageHostSettings(ownerA, 'host', getDefaultSettings('/test'), updateLocal, revision),
      { initialProps: { revision: 1 } }
    )
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    fake.rpc.mockResolvedValueOnce({ settings: projection({ claude: false }) })
    hook.rerender({ revision: 2 })
    await waitFor(() => expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(false))
    expect(fake.rpc).toHaveBeenLastCalledWith(ownerA, 'settings.get', undefined, {
      timeoutMs: 15_000
    })
  })

  it('keeps a local runtime without an owning poller unknown', async () => {
    fake.rpc.mockResolvedValueOnce({ settings: {} })
    const hook = renderHook(() => useModel({ kind: 'local' }))
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('outdated'))
    expect(hook.result.current.requestPolicy?.enabled).toBeNull()
  })
  it('shows an ambiguous failed local enable-write as unknown instead of leaving a false Off value', async () => {
    fake.rpc
      .mockResolvedValueOnce({ settings: projection({ claude: false }) })
      .mockRejectedValueOnce(new Error('Connection lost after write'))
    const hook = renderHook(() => useModel({ kind: 'local' }))
    await waitFor(() => expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(false))
    await act(async () => {
      await hook.result.current.requestPolicy?.update('claude', true)
    })
    expect(hook.result.current.requestPolicy?.access).toBe('unreachable')
    expect(hook.result.current.requestPolicy?.enabled).toBeNull()
    expect(updateLocal).not.toHaveBeenCalled()
  })
  it('keeps policy readback authoritative when an earlier MiniMax update replies after enabling requests', async () => {
    const olderUpdate = deferred<{
      settings: ReturnType<typeof projection> & { minimaxEndpoint: 'cn' }
    }>()
    fake.rpc
      .mockResolvedValueOnce({ settings: projection({ claude: false }) })
      .mockReturnValueOnce(olderUpdate.promise)
      .mockResolvedValueOnce({ settings: projection({ claude: true }) })
    const hook = renderHook(() => useModel(ownerA))
    await waitFor(() => expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(false))
    let completion: Promise<void> | undefined
    act(() => {
      completion = hook.result.current.update({ minimaxEndpoint: 'cn' })
    })
    await act(async () => {
      await hook.result.current.requestPolicy?.update('claude', true)
    })
    expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true)
    await act(async () => {
      olderUpdate.resolve({ settings: { ...projection({ claude: false }), minimaxEndpoint: 'cn' } })
      await completion
    })
    expect(hook.result.current.settings?.minimaxEndpoint).toBe('cn')
    expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true)
    expect(fake.toast).not.toHaveBeenCalled()
  })
  it('ignores a stale host read started during a policy write after matching write acknowledgement', async () => {
    const write = deferred<{ settings: ReturnType<typeof projection> }>()
    const staleRead = deferred<{ settings: ReturnType<typeof projection> }>()
    fake.rpc
      .mockResolvedValueOnce({ settings: projection({ claude: false }) })
      .mockReturnValueOnce(write.promise)
      .mockReturnValueOnce(staleRead.promise)
      .mockResolvedValueOnce({ settings: projection({ claude: true }) })
    const hook = renderHook(
      ({ revision }) =>
        useUsageHostSettings(ownerA, 'host', getDefaultSettings('/test'), updateLocal, revision),
      { initialProps: { revision: 1 } }
    )
    await waitFor(() => expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(false))
    let completion: Promise<void> | undefined
    act(() => {
      completion = hook.result.current.requestPolicy?.update('claude', true)
    })
    hook.rerender({ revision: 2 })
    await act(async () => {
      write.resolve({ settings: projection({ claude: true }) })
      await completion
    })
    await act(async () => {
      staleRead.resolve({ settings: projection({ claude: false }) })
    })
    expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true)
  })
  it('fences an older local policy read immediately at acknowledgement while UI hydration is pending', async () => {
    const write = deferred<{ settings: ReturnType<typeof projection> }>()
    const staleRead = deferred<{ settings: ReturnType<typeof projection> }>()
    const hydration = deferred<{ statusBarItems: string[] }>()
    Object.assign(window, { api: { ui: { get: vi.fn(() => hydration.promise) } } })
    fake.rpc
      .mockResolvedValueOnce({ settings: projection() })
      .mockReturnValueOnce(write.promise)
      .mockReturnValueOnce(staleRead.promise)
      .mockResolvedValueOnce({ settings: { ...projection(), antigravityUsageEnabled: true } })
    const hook = renderHook(() => useModel({ kind: 'local' }))
    await waitFor(() => expect(hook.result.current.requestPolicy?.enabled?.antigravity).toBe(false))
    let completion: Promise<void> | undefined
    act(() => {
      completion = hook.result.current.requestPolicy?.update('antigravity', true)
    })
    fake.state.rateLimits.usageRequestPolicy.revision = 2
    hook.rerender()
    await act(async () => {
      write.resolve({ settings: { ...projection(), antigravityUsageEnabled: true } })
    })
    await act(async () => {
      staleRead.resolve({ settings: projection() })
    })
    expect(hook.result.current.requestPolicy?.enabled?.antigravity).toBe(true)
    await act(async () => {
      hydration.resolve({ statusBarItems: ['antigravity'] })
      await completion
    })
    expect(hook.result.current.requestPolicy?.enabled?.antigravity).toBe(true)
  })
  it('reconciles a delayed write acknowledgement after another client has already enabled requests', async () => {
    const write = deferred<{ settings: ReturnType<typeof projection> }>()
    const latestRead = deferred<{ settings: ReturnType<typeof projection> }>()
    fake.rpc
      .mockResolvedValueOnce({ settings: projection() })
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce({ settings: projection({ claude: true }) })
      .mockReturnValueOnce(latestRead.promise)
    const hook = renderHook(
      ({ revision }) =>
        useUsageHostSettings(ownerA, 'host', getDefaultSettings('/test'), updateLocal, revision),
      { initialProps: { revision: 1 } }
    )
    await waitFor(() => expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true))
    let completion: Promise<void> | undefined
    act(() => {
      completion = hook.result.current.requestPolicy?.update('claude', false)
    })
    hook.rerender({ revision: 2 })
    await waitFor(() => expect(fake.rpc).toHaveBeenCalledTimes(3))
    await act(async () => {
      write.resolve({ settings: projection({ claude: false }) })
    })
    expect(hook.result.current.requestPolicy?.access).toBe('checking')
    expect(hook.result.current.requestPolicy?.enabled).toBeNull()
    await act(async () => {
      latestRead.resolve({ settings: projection({ claude: true }) })
      await completion
    })
    expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true)
    expect(fake.toast).not.toHaveBeenCalled()
  })
  it('keeps a newer revision read when post-ack reconciliation returns later', async () => {
    const write = deferred<{ settings: ReturnType<typeof projection> }>()
    const reconciliation = deferred<{ settings: ReturnType<typeof projection> }>()
    fake.rpc
      .mockResolvedValueOnce({ settings: projection() })
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce({ settings: projection() })
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValueOnce({ settings: projection({ claude: true }) })
    const hook = renderHook(
      ({ revision }) =>
        useUsageHostSettings(ownerA, 'host', getDefaultSettings('/test'), updateLocal, revision),
      { initialProps: { revision: 1 } }
    )
    await waitFor(() => expect(hook.result.current.requestPolicy?.access).toBe('ready'))
    let completion: Promise<void> | undefined
    act(() => {
      completion = hook.result.current.requestPolicy?.update('claude', false)
    })
    hook.rerender({ revision: 2 })
    await act(async () => {
      write.resolve({ settings: projection({ claude: false }) })
    })
    hook.rerender({ revision: 3 })
    await waitFor(() => expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true))
    await act(async () => {
      reconciliation.resolve({ settings: projection({ claude: false }) })
      await completion
    })
    expect(hook.result.current.requestPolicy?.enabled?.claude).toBe(true)
  })
})
