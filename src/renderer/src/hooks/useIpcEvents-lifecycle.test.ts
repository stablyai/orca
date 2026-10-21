import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createHarnessStoreState } from './ipc-events-test-harness'

type ListenerRecord = {
  active: boolean
  cleanup: Mock
}

describe('useIpcEvents App-lifetime lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('leaves exactly one listener per channel across cleanup and remount', async () => {
    const registrationOrder: string[] = []
    const listeners = new Map<string, ListenerRecord[]>()
    const runtimeSubscriptions: Mock[] = []
    const storeSubscriptions: { active: boolean; cleanup: Mock }[] = []
    const documentEvents = new EventTarget()
    const addDocumentListener = vi.spyOn(documentEvents, 'addEventListener')
    const removeDocumentListener = vi.spyOn(documentEvents, 'removeEventListener')
    const storeState = new Proxy(
      createHarnessStoreState({
        tabsByWorktree: { 'wt-1': [] },
        workspaceSessionReady: true,
        runtimeEnvironments: [{ id: 'runtime-1' }],
        runtimeStatusByEnvironmentId: new Map([['runtime-1', { status: 'connected' }]])
      }),
      {
        get: (target, property: string) =>
          property in target ? target[property] : property.startsWith('set') ? vi.fn() : undefined
      }
    )

    vi.doMock('../store', () => ({
      useAppStore: {
        getState: () => storeState,
        subscribe: vi.fn(() => {
          const record = { active: true, cleanup: vi.fn() }
          storeSubscriptions.push(record)
          return () => {
            record.active = false
            record.cleanup()
          }
        })
      }
    }))

    const namespace = (name: string): Record<string, unknown> =>
      new Proxy(
        {},
        {
          get: (_target, property: string) => {
            if (name === 'runtimeEnvironments' && property === 'subscribe') {
              return async () => {
                registrationOrder.push('runtimeEnvironments.subscribe')
                const unsubscribe = vi.fn()
                runtimeSubscriptions.push(unsubscribe)
                return { unsubscribe }
              }
            }
            if (property.startsWith('on')) {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                const record: ListenerRecord = { active: true, cleanup: vi.fn() }
                const records = listeners.get(`${name}.${property}`) ?? []
                records.push(record)
                listeners.set(`${name}.${property}`, records)
                return () => {
                  record.active = false
                  record.cleanup()
                }
              }
            }
            if (property === 'getStatus') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve({ state: 'idle' })
              }
            }
            if (property === 'get') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve({ limits: {}, lastUpdatedAt: 0 })
              }
            }
            if (property === 'getState') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve(null)
              }
            }
            if (property === 'clientId') {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve(null)
              }
            }
            if (property.startsWith('get') || property.startsWith('list')) {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve([])
              }
            }
            if (property.startsWith('consumePending')) {
              return () => {
                registrationOrder.push(`${name}.${property}`)
                return Promise.resolve(null)
              }
            }
            return vi.fn()
          }
        }
      )
    const api = new Proxy({}, { get: (_target, property: string) => namespace(property) })
    vi.stubGlobal('window', {
      api,
      dispatchEvent: vi.fn(),
      setTimeout,
      clearTimeout
    })

    const { installAppLifetimeIpcEvents } = await import('./ipc-events/app-lifetime-ipc-bridge')
    // Module-owned subscriptions outlive each app bridge installation.
    const moduleListeners = new Map(listeners)
    listeners.clear()
    registrationOrder.length = 0
    vi.stubGlobal('document', documentEvents)
    const firstCleanup = installAppLifetimeIpcEvents()
    await Promise.resolve()
    await Promise.resolve()
    expect(listeners.size).toBeGreaterThan(0)
    expect(runtimeSubscriptions.length).toBeGreaterThan(0)
    const groupOrder = (names: readonly string[]): string[] =>
      registrationOrder.filter((entry) => names.includes(entry))
    // Subscribe before consuming pending requests or reading snapshots, so startup cannot miss pushes.
    for (const [subscribe, read] of [
      ['ui.onOpenSettings', 'ui.consumePendingOpenSettings'],
      ['ui.onOpenSkillShare', 'ui.consumePendingSkillShare'],
      ['rateLimits.onUpdate', 'rateLimits.get'],
      ['agentStatus.onSet', 'agentStatus.getSnapshot'],
      ['agentStatus.onClear', 'agentStatus.getSnapshot'],
      ['runtime.onTerminalFitOverrideChanged', 'runtime.getTerminalFitOverrides'],
      ['runtime.onTerminalDriverChanged', 'runtime.getTerminalDrivers'],
      ['runtime.onBrowserDriverChanged', 'runtime.getBrowserDrivers'],
      ['runtime.onBrowserRemoteViewersChanged', 'runtime.getBrowserRemoteViewerPages'],
      ['runtime.onClientHostedBrowserRowsChanged', 'runtime.getClientHostedBrowserRows']
    ] as const) {
      expect(registrationOrder).toContain(subscribe)
      expect(registrationOrder.indexOf(read)).toBeGreaterThan(registrationOrder.indexOf(subscribe))
    }
    // The updater intentionally requests its initial snapshot before subscribing.
    expect(groupOrder(['updater.getStatus', 'updater.onStatus'])).toEqual([
      'updater.getStatus',
      'updater.onStatus'
    ])
    expect(
      [...listeners.values()].every((records) => records.filter((item) => item.active).length === 1)
    ).toBe(true)
    const activeSubscriptionCount = storeSubscriptions.filter((item) => item.active).length
    expect(activeSubscriptionCount).toBeGreaterThan(0)
    const documentListenerTypes = [
      'focusin',
      'pointerdown',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'input'
    ]
    expect(addDocumentListener.mock.calls.map(([type]) => type)).toEqual(documentListenerTypes)

    firstCleanup()
    expect(runtimeSubscriptions.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(
      true
    )
    expect([...listeners.values()].every((records) => records.every((item) => !item.active))).toBe(
      true
    )
    expect(storeSubscriptions.filter((item) => item.active)).toHaveLength(0)
    expect(storeSubscriptions.every((item) => item.cleanup.mock.calls.length === 1)).toBe(true)
    expect(removeDocumentListener.mock.calls).toEqual(addDocumentListener.mock.calls)
    expect(
      [...listeners.values()].every((records) =>
        records.every((item) => item.cleanup.mock.calls.length === 1)
      )
    ).toBe(true)

    const secondCleanup = installAppLifetimeIpcEvents()
    expect(
      [...listeners.values()].every((records) => records.filter((item) => item.active).length === 1)
    ).toBe(true)
    expect(storeSubscriptions.filter((item) => item.active)).toHaveLength(activeSubscriptionCount)
    expect(addDocumentListener.mock.calls.map(([type]) => type)).toEqual([
      ...documentListenerTypes,
      ...documentListenerTypes
    ])

    secondCleanup()
    await Promise.resolve()
    await Promise.resolve()
    expect(runtimeSubscriptions.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(
      true
    )
    expect([...listeners.values()].every((records) => records.every((item) => !item.active))).toBe(
      true
    )
    expect(storeSubscriptions.filter((item) => item.active)).toHaveLength(0)
    expect(storeSubscriptions.every((item) => item.cleanup.mock.calls.length === 1)).toBe(true)
    expect(removeDocumentListener.mock.calls).toEqual(addDocumentListener.mock.calls)
    expect(
      [...listeners.values()].every((records) =>
        records.every((item) => item.cleanup.mock.calls.length === 1)
      )
    ).toBe(true)
    expect(
      [...moduleListeners.values()].every((records) =>
        records.every((item) => item.active && item.cleanup.mock.calls.length === 0)
      )
    ).toBe(true)
  })
})
