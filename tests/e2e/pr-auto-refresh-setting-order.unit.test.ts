// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import type { RuntimeClientEvent } from '../../src/shared/runtime-client-events'

// The host is the real settings controller over an in-memory profile store, publishing its real
// settings-change events; its agent-view reconciliation is a finite step the test releases. The
// client is the real Settings control, host-cadence sync and client-event handler. Between them,
// unary answers travel in the order the host produced them, and can be held at that boundary; the
// event stream is a separate connection, so an event can arrive before a held answer.
const wire = vi.hoisted(() => ({
  call: vi.fn(),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture starts without a handler and registers this callback shape during mount.
  eventHandlers: null as null | { onResponse: (response: unknown) => void },
  reconcile: vi.fn(async () => {})
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: wire.call }))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh', () => ({
  subscribeRuntimeEnvironment: async (
    _request: unknown,
    handlers: { onResponse: (response: unknown) => void }
  ) => {
    wire.eventHandlers = handlers
    return { unsubscribe: () => (wire.eventHandlers = null) }
  }
}))
vi.mock('@/store/retained-views/app-state-view', () => ({
  useAppStateValue: (selector: (state: unknown) => unknown) =>
    selector({
      settingsSearchQuery: '',
      runtimeEnvironments: [{ id: 'env-a', name: 'Boston build server' }]
    })
}))
vi.mock('@/store/index', async () => {
  const { useStore } = await import('zustand')
  const { createStore } = await import('zustand/vanilla')
  const store = createStore(() => ({ settingsSearchQuery: '' }))
  return {
    useAppStore: Object.assign((select: (s: unknown) => unknown) => useStore(store, select), store)
  }
})
vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: wire.reconcile })
}))
vi.mock('../../src/main/agent-hooks/installation/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn(async () => {})
}))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  act(() => root.unmount())
  document.body.replaceChildren()
  const { _resetPRAutoRefreshCadencesForTests } =
    await import('../../src/shared/review-refresh-policy')
  const { _resetHostPRAutoRefreshCadenceGenerationsForTests } =
    await import('../../src/renderer/src/store/github/refresh/remote-host-pr-auto-refresh-cadence')
  _resetPRAutoRefreshCadencesForTests()
  _resetHostPRAutoRefreshCadenceGenerationsForTests()
})

async function host() {
  const { getDefaultSettings } = await import('../../src/shared/constants')
  const { RuntimeClientSettingsController } =
    await import('../../src/main/runtime/client/settings/runtime-client-settings')
  const { publishSettingsChanges } =
    await import('../../src/main/runtime/client/settings/runtime-settings-change-events')
  let settings: GlobalSettings = { ...getDefaultSettings('/home/host'), prAutoRefresh: 'default' }
  const listeners = new Set<(updates: Partial<GlobalSettings>, next: GlobalSettings) => void>()
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>, options?: { notifyListeners?: boolean }) => {
      settings = { ...settings, ...updates }
      if (options?.notifyListeners !== false) {
        listeners.forEach((listener) => listener(updates, settings))
      }
    },
    onSettingsChanged: (
      listener: (updates: Partial<GlobalSettings>, next: GlobalSettings) => void
    ) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    runDurableMutation: async <T>(mutate: () => T) => mutate()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller uses only these store members for settings reads and writes.
  const controller = new RuntimeClientSettingsController(store as never)
  const events: RuntimeClientEvent[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only getSettings and onSettingsChanged.
  publishSettingsChanges(store as never, (event) => events.push(event))
  return { controller, events, current: () => settings.prAutoRefresh }
}

it('converges after a real late write response revokes a later settings event read', async () => {
  const { i18n } = await import('../../src/renderer/src/i18n/i18n')
  await i18n.changeLanguage('en')
  const H = await host()
  // Answers leave the host as it produces them; while `held`, they wait at the connection.
  const answers: { result: unknown; deliver: (result: unknown) => void }[] = []
  let held = false
  const pump = () => {
    while (!held && answers.length > 0) {
      const answer = answers.shift()!
      answer.deliver(answer.result)
    }
  }
  const produced: Record<string, unknown[]> = { update: [], get: [] }
  wire.call.mockImplementation(
    (_target: unknown, method: string, params?: Pick<GlobalSettings, 'prAutoRefresh'>) =>
      new Promise((deliver) => {
        const answer =
          method === 'settings.update'
            ? H.controller.update({ prAutoRefresh: params!.prAutoRefresh })
            : Promise.resolve(H.controller.get())
        void answer.then((settings) => {
          produced[method === 'settings.update' ? 'update' : 'get'].push(settings.prAutoRefresh)
          answers.push({ result: { settings }, deliver })
          pump()
        })
      })
  )
  const deliverEvents = () => {
    for (const event of H.events.splice(0)) {
      wire.eventHandlers?.onResponse({ id: 'events', ok: true, result: event })
    }
  }
  const { subscribeRuntimeClientEvents } =
    await import('../../src/renderer/src/runtime/rpc/subscriptions/runtime-client-events')
  const { _hostPRAutoRefreshReadsInFlightForTests } =
    await import('../../src/renderer/src/store/github/refresh/remote-host-pr-auto-refresh-cadence-sync')
  const { getKnownPRAutoRefreshCadenceForHost } =
    await import('../../src/shared/review-refresh-policy')
  const { PRAutoRefreshSetting } =
    await import('../../src/renderer/src/components/settings/source-control/PRAutoRefreshSetting')
  const subscription = await subscribeRuntimeClientEvents('env-a', () => {})
  await act(async () =>
    root.render(
      createElement(PRAutoRefreshSetting, {
        hostScope: { target: { kind: 'environment', environmentId: 'env-a' }, available: true },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a remote host never reads the local settings.
        settings: {} as never,
        updateSettings: () => {}
      })
    )
  )
  await act(async () => {})
  const selected = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find(
      (button) => button.getAttribute('aria-checked') === 'true'
    )?.textContent ?? null
  expect(selected()).toBe('Default')

  // 1. This client chooses Reduced (A). The host writes it and announces it (EA) while its
  //    agent-view reconciliation is still running; EA's read (RA) answers Reduced meanwhile.
  const reconciliation = Promise.withResolvers<void>()
  wire.reconcile.mockImplementationOnce(() => reconciliation.promise)
  const reduced = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
  ).find((button) => button.textContent === 'Reduced')!
  await act(async () => reduced.click())
  await act(async () => deliverEvents())
  await act(async () => {})
  expect(produced.get).toEqual(['default', 'reduced'])

  // 2. Reconciliation ends; A's answer (the host's value then: Reduced) waits at the connection.
  held = true
  await act(async () => reconciliation.resolve())
  await act(async () => {})
  expect(produced.update).toEqual(['reduced'])

  // 3. Another client sets Off (B). Its event (EB) reaches this client on the event connection and
  //    starts a read (RB), whose answer (Off) queues behind A's.
  await act(async () => {
    await H.controller.update({ prAutoRefresh: 'off' })
    deliverEvents()
  })
  await act(async () => {})
  expect(H.current()).toBe('off')
  expect(_hostPRAutoRefreshReadsInFlightForTests()).toBe(1)

  // 4. The connection delivers A, then RB, in the order the host produced them.
  held = false
  await act(async () => pump())
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {})
  }

  expect(produced.update).toEqual(['reduced'])
  expect(produced.get.slice(0, 3)).toEqual(['default', 'reduced', 'off'])
  expect(getKnownPRAutoRefreshCadenceForHost('env-a')).toBe('off')
  expect(selected()).toBe('Off')
  expect(_hostPRAutoRefreshReadsInFlightForTests()).toBe(0)
  subscription.unsubscribe()
})
