import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeClientEventsSync } from '../hooks/runtime-client-events-sync'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import {
  getRuntimeEnvironmentRevision,
  replaceRuntimeEnvironmentRevisions
} from './runtime-environment-revision'
import {
  setRuntimeEnvironmentCatalogRefresher,
  subscribeRuntimeEnvironment
} from './runtime-environment-pairing-refresh'

const PAIRING_CHANGED = new Error(
  "Error invoking remote method 'runtimeEnvironments:subscribe': Error: Runtime environment pairing changed; refresh and try again"
)

/** Main's current record: an on-connect update re-paired the server to revision 2. */
function installMain(onCatalogWrite: () => void = () => {}): {
  subscribe: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
} {
  const refuseStale = (args: { expectedEnvironmentPairingRevision?: number }): void => {
    if (args.expectedEnvironmentPairingRevision !== 2) {
      throw PAIRING_CHANGED
    }
  }
  const subscribe = vi.fn(async (args: { expectedEnvironmentPairingRevision?: number }) => {
    refuseStale(args)
    return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
  })
  const call = vi.fn(async (args: { expectedEnvironmentPairingRevision?: number }) => {
    refuseStale(args)
    return { ok: true, result: {} }
  })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe, call } } })
  setRuntimeEnvironmentCatalogRefresher(async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }])
    // The app's store-write subscriber resyncs subscriptions keyed on the revision.
    onCatalogWrite()
  })
  return { subscribe, call }
}

afterEach(() => {
  setRuntimeEnvironmentCatalogRefresher(null)
  replaceRuntimeEnvironmentRevisions([])
  vi.unstubAllGlobals()
})

describe('a pairing rotation under a live subscriber', () => {
  it('resubscribes with the new pairing on the next retry, without a reload', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
    const { subscribe } = installMain(() => sync.sync())
    const sync = createRuntimeClientEventsSync({
      getDesiredEnvironmentIds: () => ['env-1'],
      getSubscriptionKey: (id) => `${id}:${getRuntimeEnvironmentRevision(id)}`,
      subscribe: (id) =>
        subscribeRuntimeEnvironment(
          {
            selector: id,
            method: 'runtime.clientEvents.subscribe',
            expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(id)
          },
          { onResponse: vi.fn() }
        ),
      onEvent: vi.fn()
    })

    sync.sync()
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    sync.stop()

    expect(subscribe.mock.calls.map(([args]) => args.expectedEnvironmentPairingRevision)).toEqual([
      1, 2
    ])
  })

  it('re-reads the pairing when a request is refused, so the next one goes through', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
    installMain()
    const request = () =>
      callRuntimeEnvironmentWithRevision({
        environmentId: 'env-1',
        method: 'repo.list',
        params: undefined,
        expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision('env-1')
      })

    await expect(request()).rejects.toThrow('pairing changed')
    await vi.waitFor(() => expect(getRuntimeEnvironmentRevision('env-1')).toBe(2))
    await expect(request()).resolves.toMatchObject({ ok: true })
  })
})
