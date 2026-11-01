// @vitest-environment happy-dom

import { z } from 'zod'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import { StatusBarItem, UiUpdateFields } from '../../../../shared/rpc-contract/client-ui-params'
import { createUIStore } from '../../store/slices/ui-slice-test-harness'
import { createWebUiApi } from './web-ui-api'

const runtime = vi.hoisted(() => ({ call: vi.fn(), id: 'old' }))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => ({ id: runtime.id })
}))

const oldSchema = UiUpdateFields.omit({ _museStatusBarDefaultAdded: true }).extend({
  statusBarItems: z.array(StatusBarItem.exclude(['muse'])).optional()
})

beforeEach(() => {
  localStorage.clear()
  runtime.call.mockReset()
  runtime.id = 'old'
})
afterEach(() => vi.unstubAllGlobals())

function oldHostUI() {
  const ui = getDefaultUIState()
  delete ui._museStatusBarDefaultAdded
  ui.statusBarItems = ['ports']
  return ui
}

it('migrates against a strict older host and preserves Muse choices across host refreshes', async () => {
  const olderUI = oldHostUI()
  const rejected: unknown[] = []
  runtime.call.mockImplementation(async (method: string, params: unknown) => {
    if (method === 'ui.set') {
      const parsed = oldSchema.safeParse(params)
      if (!parsed.success) {
        rejected.push(params)
        throw parsed.error
      }
      Object.assign(olderUI, parsed.data)
    }
    return { ui: olderUI }
  })
  const ui = createWebUiApi()
  const store = createUIStore()
  const hydrated = await ui.get()
  vi.stubGlobal('window', { localStorage, api: { ui } })
  store.getState().hydratePersistedUI(hydrated)
  expect(store.getState().statusBarItems).toContain('muse')
  expect(olderUI.statusBarItems).toContain('kimi')
  expect(olderUI.statusBarItems).not.toContain('muse')
  expect(olderUI._museStatusBarDefaultAdded).toBeUndefined()
  expect(rejected).toEqual([])

  const refreshed = await ui.get()
  expect(refreshed._museStatusBarDefaultAdded).toBe(true)
  expect(refreshed.statusBarItems).toContain('muse')
  store.getState().hydratePersistedUI(refreshed)
  store.getState().toggleStatusBarItem('muse')
  const hidden = await ui.get()
  expect(hidden.statusBarItems).not.toContain('muse')
  expect(hidden.statusBarItems).toEqual(olderUI.statusBarItems)
  expect(rejected).toEqual([])
})

it('gates acknowledged writes per host and uses newer hosts as the preference authority', async () => {
  const olderUI = oldHostUI()
  const newerUI = { ...getDefaultUIState(), statusBarItems: ['kimi' as const] }
  runtime.call.mockImplementation(async (method: string, params: unknown) => {
    const state = runtime.id === 'old' ? olderUI : newerUI
    if (method === 'ui.set') {
      const schema = runtime.id === 'old' ? oldSchema : UiUpdateFields
      Object.assign(state, schema.parse(params))
    }
    return { ui: state }
  })
  const ui = createWebUiApi()
  const setWithAck = ui.setWithAck
  if (!setWithAck) {
    throw new Error('Acknowledged UI writes are unavailable')
  }
  runtime.id = 'new'
  expect((await ui.get())._museStatusBarDefaultAdded).toBe(false)
  await setWithAck({ statusBarItems: ['kimi', 'muse'], _museStatusBarDefaultAdded: true })
  expect(newerUI.statusBarItems).toEqual(['kimi', 'muse'])
  expect(newerUI._museStatusBarDefaultAdded).toBe(true)

  runtime.id = 'old'
  await ui.get()
  await expect(
    setWithAck({
      statusBarItems: ['ports', 'muse'],
      _museStatusBarDefaultAdded: true,
      statusBarVisible: false
    })
  ).rejects.toThrow('Muse status bar preference is pending host support')
  expect(olderUI.statusBarItems).toEqual(['ports'])
  expect(olderUI.statusBarVisible).toBe(false)
  expect((await ui.get()).statusBarItems).toEqual(['ports', 'muse'])
  await setWithAck({ statusBarVisible: true })
  expect(olderUI.statusBarVisible).toBe(true)

  runtime.id = 'new'
  expect((await ui.get()).statusBarItems).toEqual(['kimi', 'muse'])
  await setWithAck({ statusBarItems: ['kimi'] })
  expect((await ui.get()).statusBarItems).toEqual(['kimi'])
})
