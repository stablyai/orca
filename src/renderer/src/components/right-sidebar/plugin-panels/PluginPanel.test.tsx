// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string) => fallback
}))

const { usePluginPanelsMock, setPanelHealthMock } = vi.hoisted(() => ({
  usePluginPanelsMock: vi.fn<() => ActivePluginPanel[]>(() => []),
  setPanelHealthMock: vi.fn()
}))

const { watchdogStartMock, watchdogStopMock, watchdogCallbacks } = vi.hoisted(() => ({
  watchdogStartMock: vi.fn(),
  watchdogStopMock: vi.fn(),
  watchdogCallbacks: { onUnresponsive: null as (() => void) | null }
}))

vi.mock('@/store/plugins/catalog/plugin-contribution-catalog', () => ({
  usePluginPanels: usePluginPanelsMock,
  usePluginPanelsStore: (
    selector: (state: { setPanelHealth: typeof setPanelHealthMock }) => unknown
  ) => selector({ setPanelHealth: setPanelHealthMock })
}))

vi.mock('./health/plugin-panel-watchdog', () => ({
  createPanelWatchdog: (options: { onUnresponsive: () => void }) => {
    watchdogCallbacks.onUnresponsive = options.onUnresponsive
    return {
      start: watchdogStartMock,
      stop: watchdogStopMock,
      handlePong: vi.fn()
    }
  }
}))

import PluginPanel from './PluginPanel'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const dashboardPanel: ActivePluginPanel = {
  id: 'dashboard',
  title: 'Dashboard',
  icon: 'gauge',
  tabKey: 'plugin:samples.my-plugin/dashboard',
  pluginKey: 'samples.my-plugin',
  pluginName: 'My Plugin'
}

let container: HTMLDivElement
let root: Root
const readPanelEntryMock = vi.fn()
const panelActionMock = vi.fn()
const SESSION_TOKEN = 's'.repeat(43)
const REFRESHED_SESSION_TOKEN = 'r'.repeat(43)
let pluginChangedListener: (() => void) | null

function waitForHappyDomTasks(): Promise<void> {
  return (
    window as unknown as { happyDOM: { waitUntilComplete: () => Promise<void> } }
  ).happyDOM.waitUntilComplete()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  readPanelEntryMock.mockReset()
  panelActionMock.mockReset()
  panelActionMock.mockResolvedValue({ ok: true, value: { delivered: true } })
  watchdogStartMock.mockReset()
  watchdogStopMock.mockReset()
  watchdogCallbacks.onUnresponsive = null
  setPanelHealthMock.mockReset()
  document.documentElement.classList.remove('dark')
  pluginChangedListener = null
  usePluginPanelsMock.mockReturnValue([dashboardPanel])
  globalThis.window.api = {
    plugins: {
      readPanelEntry: readPanelEntryMock,
      panelAction: panelActionMock,
      onChanged: (listener: () => void) => {
        pluginChangedListener = listener
        return vi.fn()
      }
    }
  } as unknown as Window['api']
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function renderPanel(tabKey: string): Promise<void> {
  await act(async () => {
    root.render(<PluginPanel tabKey={tabKey} />)
  })
}

describe('PluginPanel', () => {
  it('remounts a guest that main closed at an unchanged URL, then gives up after a few tries', async () => {
    const guest = {
      partition: 'persist:orca-plugin-0123456789abcdef',
      url: 'orca-plugin-frame://0123456789abcdef/panel.html'
    }
    readPanelEntryMock.mockResolvedValue({ html: '', sessionToken: SESSION_TOKEN, guest })
    await renderPanel('plugin:samples.my-plugin/dashboard')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = container.querySelector('webview')
      await act(async () => {
        before?.dispatchEvent(new Event('destroyed'))
        await waitForHappyDomTasks()
      })
      const after = container.querySelector('webview')
      expect(after).not.toBeNull()
      expect(after).not.toBe(before)
    }
    expect(readPanelEntryMock).toHaveBeenCalledTimes(4)
    await act(async () => {
      container.querySelector('webview')?.dispatchEvent(new Event('render-process-gone'))
      await waitForHappyDomTasks()
    })
    expect(container.querySelector('webview')).toBeNull()
    expect(container.textContent).toContain('could not be loaded')
  })

  it('accepts a reloaded declarative guest that counts revisions from 1 again', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '',
      sessionToken: SESSION_TOKEN,
      guest: { partition: 'persist:orca-plugin-0123456789abcdef', url: 'orca-plugin-frame://x/y' },
      ui: 'components'
    })
    await renderPanel('plugin:samples.my-plugin/dashboard')
    const webview = container.querySelector('webview')
    Object.assign(webview!, { send: vi.fn() })
    const render = async (revision: number, text: string) => {
      await act(async () => {
        webview?.dispatchEvent(
          Object.assign(new Event('ipc-message'), {
            channel: 'orca-plugin-frame',
            args: [
              {
                orca: 1,
                kind: 'evt',
                event: 'ui.render',
                payload: {
                  document: 'd1',
                  revision,
                  tree: { type: 'Text', props: {}, children: [text] }
                }
              },
              false
            ]
          })
        )
        await waitForHappyDomTasks()
      })
    }
    await render(5, 'before reload')
    await act(async () => {
      webview?.dispatchEvent(new Event('did-start-loading'))
    })
    await render(1, 'after reload')
    expect(container.textContent).toContain('after reload')
  })

  it('hot reloads a dev components panel: last good tree on a broken save, memory atoms handed over', async () => {
    const devGuest = (rev: number) => ({
      partition: 'persist:orca-plugin-0123456789abcdef',
      url: `orca-plugin-frame://0123456789abcdef/__orca/declarative-host.html?entry=p.tsx&rev=dev-${rev}`,
      dev: true
    })
    const entry = (rev: number) => ({
      html: '',
      sessionToken: SESSION_TOKEN,
      guest: devGuest(rev),
      ui: 'components'
    })
    readPanelEntryMock.mockResolvedValue(entry(1))
    await renderPanel('plugin:samples.my-plugin/dashboard')
    const guestOf = () => {
      const webview = container.querySelector('webview')!
      const send = vi.fn()
      Object.assign(webview, { send })
      const post = async (event: string, payload: unknown) => {
        await act(async () => {
          webview.dispatchEvent(
            Object.assign(new Event('ipc-message'), {
              channel: 'orca-plugin-frame',
              args: [{ orca: 1, kind: 'evt', event, payload }, false]
            })
          )
          await waitForHappyDomTasks()
        })
      }
      const hydrates = () =>
        send.mock.calls
          .filter(([, envelope]) => envelope.event === 'ui.hydrate')
          .map(([, envelope]) => envelope.payload)
      return { webview, post, hydrates }
    }
    const text = (value: string) => ({ type: 'Text', props: {}, children: [value] })
    const first = guestOf()
    await first.post('ui.ready', { document: 'd1' })
    expect(first.hydrates()[0]).toMatchObject({ retain: true })
    await first.post('ui.render', { document: 'd1', revision: 1, tree: text('draft: hi') })
    await first.post('ui.retain', {
      document: 'd1',
      entries: [{ key: 'draft', version: 1, value: 'hi' }]
    })

    // A save that does not load: a new guest, the old tree stays, and an inline error names the line.
    readPanelEntryMock.mockResolvedValue(entry(2))
    await act(async () => {
      pluginChangedListener?.()
      await waitForHappyDomTasks()
    })
    const broken = guestOf()
    expect(broken.webview).not.toBe(first.webview)
    await broken.post('ui.error', { revision: 0, message: 'src/p.tsx:3:5: Unexpected token' })
    expect(container.textContent).toContain('draft: hi')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'src/p.tsx:3:5: Unexpected token'
    )

    // The fix loads: seeded with the retained atoms, it replaces the tree and clears the error.
    readPanelEntryMock.mockResolvedValue(entry(3))
    await act(async () => {
      pluginChangedListener?.()
      await waitForHappyDomTasks()
    })
    const fixed = guestOf()
    await fixed.post('ui.ready', { document: 'd3' })
    expect(fixed.hydrates()[0]).toMatchObject({
      memory: { draft: { version: 1, value: 'hi' } },
      retain: true
    })
    await fixed.post('ui.render', { document: 'd3', revision: 1, tree: text('draft: hi (v3)') })
    expect(container.textContent).toContain('draft: hi (v3)')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('Reloaded')
  })

  it('restyles in place with fresh host theme tokens when the app theme changes', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<html class="__ORCA_COLOR_SCHEME__"><head><style>:root{/*__ORCA_PANEL_TOKENS__*/}</style></head>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:samples.my-plugin/dashboard')
    const lightFrame = container.querySelector('iframe')
    expect(lightFrame?.getAttribute('srcdoc')).toContain('<html class="light">')
    const frameWindow = lightFrame?.contentWindow
    if (!frameWindow) {
      throw new Error('frame window missing')
    }
    const posted = vi.spyOn(frameWindow, 'postMessage')

    await act(async () => {
      document.documentElement.classList.add('dark')
      await waitForHappyDomTasks()
    })

    // Why the same frame: remounting would discard the panel's own state.
    expect(container.querySelector('iframe')).toBe(lightFrame)
    expect(posted).toHaveBeenCalledWith(
      {
        orca: 1,
        kind: 'evt',
        event: 'theme',
        payload: { colorScheme: 'dark', tokens: expect.any(String) }
      },
      '*'
    )
  })

  it('rebinds a refreshed session without remounting unchanged panel HTML', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:samples.my-plugin/dashboard')
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(watchdogStartMock).toHaveBeenCalledTimes(1)

    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: REFRESHED_SESSION_TOKEN
    })
    await act(async () => {
      pluginChangedListener?.()
      await waitForHappyDomTasks()
    })

    expect(container.querySelector('iframe')).toBe(iframe)
    expect(watchdogStopMock).not.toHaveBeenCalled()
    expect(watchdogStartMock).toHaveBeenCalledTimes(1)

    const event = new MessageEvent('message', {
      data: {
        orca: 1,
        kind: 'req',
        id: 1,
        method: 'notifications.show',
        params: { title: 'Hello' }
      }
    })
    Object.defineProperty(event, 'source', { value: iframe?.contentWindow })
    await act(async () => {
      window.dispatchEvent(event)
      await waitForHappyDomTasks()
    })
    expect(panelActionMock).toHaveBeenCalledWith({
      sessionToken: REFRESHED_SESSION_TOKEN,
      action: 'notifications.show',
      params: { title: 'Hello' }
    })
  })

  it('ignores an obsolete panel reload that finishes after a newer one', async () => {
    readPanelEntryMock.mockResolvedValueOnce({
      html: '<h1>Initial plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:samples.my-plugin/dashboard')

    let resolveObsolete!: (entry: null) => void
    let resolveCurrent!: (entry: { html: string; sessionToken: string }) => void
    readPanelEntryMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveObsolete = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCurrent = resolve
          })
      )

    await act(async () => {
      pluginChangedListener?.()
      pluginChangedListener?.()
      resolveCurrent({
        html: '<h1>Current plugin</h1>',
        sessionToken: REFRESHED_SESSION_TOKEN
      })
      await waitForHappyDomTasks()
    })
    await act(async () => {
      resolveObsolete(null)
      await waitForHappyDomTasks()
    })

    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Current plugin')
    expect(container.textContent).not.toContain('could not be loaded')
  })

  it('recovers from a transient read failure with byte-identical HTML', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:samples.my-plugin/dashboard')
    const initialFrame = container.querySelector('iframe')

    readPanelEntryMock.mockResolvedValueOnce(null)
    await act(async () => {
      pluginChangedListener?.()
      await waitForHappyDomTasks()
    })
    expect(container.textContent).toContain('could not be loaded')

    readPanelEntryMock.mockResolvedValueOnce({
      html: '<h1>Hello plugin</h1>',
      sessionToken: REFRESHED_SESSION_TOKEN
    })
    await act(async () => {
      pluginChangedListener?.()
      await waitForHappyDomTasks()
    })

    expect(container.querySelector('iframe')).not.toBe(initialFrame)
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Hello plugin')
    expect(setPanelHealthMock).toHaveBeenLastCalledWith(
      'plugin:samples.my-plugin/dashboard',
      'healthy'
    )
  })

  it('stays suspended, and reported as failed, when the plugin list changes but its HTML does not', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:samples.my-plugin/dashboard')
    await act(async () => watchdogCallbacks.onUnresponsive?.())

    await act(async () => {
      pluginChangedListener?.()
      await waitForHappyDomTasks()
    })

    expect(container.textContent).toContain('stopped responding and was suspended')
    expect(setPanelHealthMock).toHaveBeenLastCalledWith(
      'plugin:samples.my-plugin/dashboard',
      'error'
    )
  })
})
