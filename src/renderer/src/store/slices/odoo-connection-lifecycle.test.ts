import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { OdooConnectionStatus, OdooInstance } from '../../../../shared/odoo-types'

const mocks = vi.hoisted(() => ({
  odooStatus: vi.fn<() => Promise<OdooConnectionStatus>>()
}))

vi.mock('@/runtime/runtime-odoo-client', () => ({
  odooConnect: vi.fn(),
  odooDisconnect: vi.fn(),
  odooSelectInstance: vi.fn(),
  odooStatus: () => mocks.odooStatus(),
  odooTestConnection: vi.fn()
}))

const { createOdooConnectionLifecycle } = await import('./odoo-connection-lifecycle')

function instance(overrides: Partial<OdooInstance> = {}): OdooInstance {
  return {
    id: 'inst-1',
    serverUrl: 'https://odoo.example.test',
    database: 'prod',
    login: 'dev@example.test',
    uid: 7,
    displayName: 'Prod',
    ...overrides
  }
}

type Harness = {
  checkOdooConnection: () => Promise<void>
  state: () => AppState
  setCount: () => number
}

function createHarness(initialStatus: OdooConnectionStatus): Harness {
  let setCalls = 0
  const state = {
    settings: { activeRuntimeEnvironmentId: null },
    odooStatus: initialStatus,
    odooStatusChecked: true,
    odooStatusContextKey: null as string | null
  } as unknown as AppState

  const set: StoreApi<AppState>['setState'] = (partial) => {
    setCalls += 1
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const lifecycle = createOdooConnectionLifecycle({
    set,
    get: (() => state) as StoreApi<AppState>['getState'],
    clearInflight: () => {}
  })
  return {
    checkOdooConnection: lifecycle.checkOdooConnection,
    state: () => state,
    setCount: () => setCalls
  }
}

describe('checkOdooConnection instance comparison', () => {
  beforeEach(() => {
    mocks.odooStatus.mockReset()
  })

  it('adopts a renamed instance even though the instance count is unchanged', async () => {
    const harness = createHarness({
      connected: true,
      viewer: null,
      instances: [instance()]
    })
    // First call stamps the context key so a later `set` can only come from the
    // instance comparison itself.
    mocks.odooStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      instances: [instance()]
    })
    await harness.checkOdooConnection()
    const baseline = harness.setCount()

    // One field at a time: changing both at once would still pass if the
    // signature dropped either of them.
    mocks.odooStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      instances: [instance({ displayName: 'Production EU' })]
    })
    await harness.checkOdooConnection()

    expect(harness.setCount()).toBe(baseline + 1)
    expect(harness.state().odooStatus.instances?.[0]?.displayName).toBe('Production EU')

    mocks.odooStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      instances: [instance({ displayName: 'Production EU', serverUrl: 'https://eu.example.test' })]
    })
    await harness.checkOdooConnection()

    expect(harness.setCount()).toBe(baseline + 2)
    expect(harness.state().odooStatus.instances?.[0]?.serverUrl).toBe('https://eu.example.test')
  })

  it('skips the update when the instance list is unchanged', async () => {
    const harness = createHarness({
      connected: true,
      viewer: null,
      instances: [instance()]
    })
    mocks.odooStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      instances: [instance()]
    })
    await harness.checkOdooConnection()
    const baseline = harness.setCount()

    await harness.checkOdooConnection()

    expect(harness.setCount()).toBe(baseline)
  })
})
