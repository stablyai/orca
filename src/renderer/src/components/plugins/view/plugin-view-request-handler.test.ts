// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useAppStore } from '@/store'
import { useCustomEditorViewStore } from '@/store/plugin-custom-editors'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { reportPluginPanelDraw } from '../../right-sidebar/plugin-panel-draw-status'
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

function mountSurface(rect: { x: number; y: number; width: number; height: number }) {
  const surface = document.createElement('div')
  surface.setAttribute('data-plugin-panel-surface', TAB)
  surface.getBoundingClientRect = () => DOMRect.fromRect(rect)
  document.body.append(surface)
  return surface
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
  it('shows the panel in the right sidebar', async () => {
    const reply = await handlePluginViewRequest({
      requestId: 'r1',
      kind: 'open-panel',
      pluginKey: KEY,
      panelId: 'todos'
    })
    expect(reply).toEqual({ requestId: 'r1', ok: true })
    expect(useAppStore.getState()).toMatchObject({ rightSidebarOpen: true, rightSidebarTab: TAB })
  })

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

  it('refuses a window with no workspace and a panel it does not list', async () => {
    useAppStore.setState({ activeWorktreeId: null })
    await expect(
      handlePluginViewRequest({
        requestId: 'r',
        kind: 'open-panel',
        pluginKey: KEY,
        panelId: 'todos'
      })
    ).resolves.toMatchObject({ ok: false, code: 'no_workspace' })
    await expect(
      handlePluginViewRequest({ requestId: 'r', kind: 'open-panel', pluginKey: KEY, panelId: 'x' })
    ).resolves.toMatchObject({ ok: false, code: 'panel_unavailable' })
  })
})

describe('open-panel with a capture', () => {
  it('waits for the current guest, then reports the rect, theme and width it drew at', async () => {
    mountSurface({ x: 900, y: 40, width: 359, height: 700 })
    const pending = handlePluginViewRequest({
      requestId: 'r1',
      kind: 'open-panel',
      pluginKey: KEY,
      panelId: 'todos',
      capture: { guestRevision: 'r2', width: 360, colorScheme: 'dark', timeoutMs: 5_000 }
    })
    await vi.waitFor(() => expect(usePluginViewCaptureStore.getState().dark).toBe(true))
    expect(usePluginViewCaptureStore.getState().panelWidth).toBe(360)
    // The replaced guest's tree does not count; the current one does.
    reportPluginPanelDraw(TAB, {
      ui: 'components',
      guestUrl: 'g?rev=r1',
      drawn: true,
      issue: null,
      failure: null
    })
    document.documentElement.classList.add('dark')
    reportPluginPanelDraw(TAB, {
      ui: 'components',
      guestUrl: 'g?rev=r2',
      drawn: true,
      issue: 'Line 3: boom',
      failure: null
    })
    const reply = await pending
    expect(reply).toEqual({
      requestId: 'r1',
      ok: true,
      panel: {
        rect: { x: 900, y: 40, width: 359, height: 700 },
        ui: 'components',
        guestUrl: 'g?rev=r2',
        issue: 'Line 3: boom',
        colorScheme: 'dark',
        themeApplied: true,
        settled: true
      }
    })
    // One correction for the sidebar border so the panel itself is --width wide.
    expect(usePluginViewCaptureStore.getState().panelWidth).toBe(361)
    await handlePluginViewRequest({ requestId: 'r2', kind: 'end-capture' })
    expect(usePluginViewCaptureStore.getState()).toMatchObject({ panelWidth: null, dark: null })
  })

  it('gives up at the deadline with whatever is drawn, and fails a panel that cannot draw', async () => {
    mountSurface({ x: 0, y: 0, width: 300, height: 500 })
    await expect(
      handlePluginViewRequest({
        requestId: 'r',
        kind: 'open-panel',
        pluginKey: KEY,
        panelId: 'todos',
        capture: { guestRevision: 'r9', timeoutMs: 5 }
      })
    ).resolves.toMatchObject({ ok: true, panel: { settled: false, themeApplied: false } })
    reportPluginPanelDraw(TAB, {
      ui: 'html',
      guestUrl: null,
      drawn: false,
      issue: null,
      failure: 'stopped responding'
    })
    await expect(
      handlePluginViewRequest({
        requestId: 'r',
        kind: 'open-panel',
        pluginKey: KEY,
        panelId: 'todos',
        capture: { guestRevision: 'r9', timeoutMs: 5_000 }
      })
    ).resolves.toMatchObject({ ok: false, code: 'panel_failed' })
  })
})

describe('open-panel for an html panel', () => {
  it("reports the guest webview's rect so main can capture the guest itself", async () => {
    const surface = mountSurface({ x: 900, y: 40, width: 360, height: 700 })
    const guest = document.createElement('webview')
    guest.getBoundingClientRect = () => DOMRect.fromRect({ x: 900, y: 72, width: 360, height: 668 })
    surface.append(guest)
    const pending = handlePluginViewRequest({
      requestId: 'r',
      kind: 'open-panel',
      pluginKey: KEY,
      panelId: 'todos',
      capture: { guestRevision: null, timeoutMs: 5_000 }
    })
    reportPluginPanelDraw(TAB, {
      ui: 'html',
      guestUrl: 'g',
      drawn: true,
      issue: null,
      failure: null
    })
    await expect(pending).resolves.toMatchObject({
      ok: true,
      panel: { ui: 'html', guestRect: { x: 900, y: 72, width: 360, height: 668 } }
    })
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

  it('captures when the panel is the open tab', async () => {
    useAppStore.setState({ rightSidebarOpen: true, rightSidebarTab: TAB })
    mountSurface({ x: 0, y: 0, width: 300, height: 500 })
    reportPluginPanelDraw(TAB, {
      ui: 'components',
      guestUrl: 'g?rev=r1',
      drawn: true,
      issue: null,
      failure: null
    })
    await expect(
      handlePluginViewRequest({
        requestId: 'r',
        kind: 'open-panel',
        pluginKey: KEY,
        panelId: 'todos',
        capture: { guestRevision: 'r1', ifShown: true, timeoutMs: 5_000 }
      })
    ).resolves.toMatchObject({ ok: true, panel: { settled: true } })
  })
})

describe('open-editor', () => {
  it('opens the file in the active workspace with the plugin editor chosen', async () => {
    const openFile = vi.fn().mockReturnValue('file-1')
    useAppStore.setState({ openFile })
    await expect(
      handlePluginViewRequest({
        requestId: 'r',
        kind: 'open-editor',
        pluginKey: KEY,
        editorId: 'notes',
        filePath: '/elsewhere/plan.notes'
      })
    ).resolves.toEqual({ requestId: 'r', ok: true })
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/elsewhere/plan.notes',
        relativePath: '/elsewhere/plan.notes',
        worktreeId: 'wt-1',
        mode: 'edit'
      }),
      { preview: false }
    )
    expect(useCustomEditorViewStore.getState().choices['file-1']).toBe(`${KEY}/notes`)
  })
})
