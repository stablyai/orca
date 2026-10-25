// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import { UiUpdateFields } from '../../../../shared/rpc-contract/client-ui-params'
import { createUIStore } from '../../store/slices/ui-slice-test-harness'
import { createWebUiApi } from './web-ui-api'

const runtime = vi.hoisted(() => ({ call: vi.fn(), id: 'new' }))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => ({ id: runtime.id })
}))

beforeEach(() => {
  localStorage.clear()
  runtime.call.mockReset()
  runtime.id = 'new'
})
afterEach(() => vi.unstubAllGlobals())

it.each(['verbose', 'compact'] as const)(
  'saves %s to an older host after caching a pending notice from a newer host',
  async (mode) => {
    const ui = createWebUiApi()
    runtime.call.mockResolvedValue({
      ui: { ...getDefaultUIState(), statusBarCompactChangeNoticeDismissed: false }
    })
    expect((await ui.get()).statusBarCompactChangeNoticeDismissed).toBe(false)

    runtime.id = 'old'
    const oldHostSchema = UiUpdateFields.omit({ statusBarCompactChangeNoticeDismissed: true })
    const olderUI = getDefaultUIState()
    delete olderUI.statusBarCompactChangeNoticeDismissed
    runtime.call.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'ui.set') {
        Object.assign(olderUI, oldHostSchema.parse(params))
      }
      return { ui: olderUI }
    })
    const hydrated = await ui.get()
    expect(hydrated.statusBarCompactChangeNoticeDismissed).toBe(true)

    const store = createUIStore()
    vi.stubGlobal('window', { localStorage, api: { ui } })
    store.getState().hydratePersistedUI(hydrated)
    store.getState().setStatusBarUsageMode(mode)

    expect(runtime.call).toHaveBeenLastCalledWith('ui.set', { statusBarUsageMode: mode }, 15_000)
    expect(olderUI.statusBarUsageMode).toBe(mode)
    expect((await ui.get()).statusBarUsageMode).toBe(mode)
  }
)

it.each([false, true])(
  'uses the newer host notice state %s after returning from an older host',
  async (dismissed) => {
    const ui = createWebUiApi()
    const olderUI = getDefaultUIState()
    delete olderUI.statusBarCompactChangeNoticeDismissed
    runtime.id = 'old'
    runtime.call.mockResolvedValue({ ui: olderUI })
    expect((await ui.get()).statusBarCompactChangeNoticeDismissed).toBe(true)

    runtime.id = 'new'
    runtime.call.mockResolvedValue({
      ui: { ...getDefaultUIState(), statusBarCompactChangeNoticeDismissed: dismissed }
    })
    expect((await ui.get()).statusBarCompactChangeNoticeDismissed).toBe(dismissed)
  }
)
