// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useAppStore } from '@/store'
import { usePluginViewCaptureStore } from '@/store/plugins/capture/plugin-view-capture'
import { reportPluginPanelDraw } from '../../right-sidebar/plugin-panels/health/plugin-panel-draw-status'
import { handlePluginViewRequest } from './plugin-view-request-handler'

const KEY = 'acme.todos'
const TAB = `plugin:${KEY}/todos` as const
const initialState = useAppStore.getState()

function plugin(): PluginHostListEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler and the stores read only these fields.
  return {
    pluginKey: KEY,
    name: 'Todos',
    status: 'idle',
    panels: [{ id: 'todos', title: 'Todos', tabKey: TAB }],
    customEditors: [
      { id: 'notes', title: 'Notes', extensions: ['.notes'], filenames: [], priority: 'option' }
    ],
    commands: []
  } as unknown as PluginHostListEntry
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { list: vi.fn().mockResolvedValue([plugin()]) } }
  })
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    rightSidebarOpen: false
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  usePluginViewCaptureStore.getState().end()
  reportPluginPanelDraw(TAB, null)
  document.body.innerHTML = ''
  document.documentElement.classList.remove('dark')
})

describe('open-panel', () => {
  it('leaves Settings to show it, but a capture never changes the view', async () => {
    useAppStore.setState({ activeView: 'settings', previousViewBeforeSettings: 'terminal' })
    const captured = await handlePluginViewRequest({
      requestId: 'r1',
      kind: 'open-panel',
      pluginKey: KEY,
      panelId: 'todos',
      capture: { guestRevision: null, timeoutMs: 10 }
    })
    expect(captured).toMatchObject({ ok: false, code: 'no_workspace' })
    expect(useAppStore.getState().activeView).toBe('settings')
    await handlePluginViewRequest({
      requestId: 'r2',
      kind: 'open-panel',
      pluginKey: KEY,
      panelId: 'todos'
    })
    expect(useAppStore.getState().activeView).toBe('terminal')
  })
})

describe('open-panel with ifShown', () => {
  it('never opens or switches: another tab or a closed sidebar answers not_shown', async () => {
    useAppStore.setState({ rightSidebarOpen: true, rightSidebarTab: 'explorer' })
    const request = {
      requestId: 'r',
      kind: 'open-panel' as const,
      pluginKey: KEY,
      panelId: 'todos',
      capture: { guestRevision: null, ifShown: true, timeoutMs: 5_000 }
    }
    await expect(handlePluginViewRequest(request)).resolves.toEqual({
      requestId: 'r',
      ok: false,
      code: 'not_shown',
      message: 'the right sidebar shows another tab'
    })
    expect(useAppStore.getState()).toMatchObject({
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer'
    })
    useAppStore.setState({ rightSidebarOpen: false, rightSidebarTab: TAB })
    await expect(handlePluginViewRequest(request)).resolves.toMatchObject({
      message: 'the right sidebar is closed'
    })
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  })
})
