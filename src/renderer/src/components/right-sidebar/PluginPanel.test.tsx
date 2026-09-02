// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugin-panels'

vi.mock('@/i18n/i18n', () => ({
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

vi.mock('@/store/plugin-panels', () => ({
  usePluginPanels: usePluginPanelsMock,
  usePluginPanelsStore: (
    selector: (state: { setPanelHealth: typeof setPanelHealthMock }) => unknown
  ) => selector({ setPanelHealth: setPanelHealthMock })
}))

vi.mock('./plugin-panel-watchdog', () => ({
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
  tabKey: 'plugin:orca-samples.my-plugin/dashboard',
  pluginKey: 'orca-samples.my-plugin',
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
  it('renders the panel HTML in a scripts-only sandboxed iframe', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })

    await renderPanel('plugin:orca-samples.my-plugin/dashboard')

    const initialIframe = container.querySelector('iframe')
    expect(initialIframe).not.toBeNull()
    expect(readPanelEntryMock).toHaveBeenCalledWith({
      pluginKey: 'orca-samples.my-plugin',
      panelId: 'dashboard'
    })
    expect(initialIframe?.getAttribute('srcdoc')).toContain('<h1>Hello plugin</h1>')
    expect(initialIframe?.getAttribute('title')).toBe('Dashboard')
    expect(initialIframe?.getAttribute('name')).toBe(
      'orca-plugin-panel:plugin:orca-samples.my-plugin/dashboard'
    )
    // Why: allow-same-origin would let plugin HTML reach the app DOM/storage;
    // the sandbox must stay scripts-only.
    expect(initialIframe?.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('restarts the watchdog after a dev reload replaces the panel document', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })

    await renderPanel('plugin:orca-samples.my-plugin/dashboard')

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(watchdogStartMock).toHaveBeenCalledTimes(1)

    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Reloaded plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await act(async () => {
      pluginChangedListener?.()
      await waitForHappyDomTasks()
    })

    const reloadedIframe = container.querySelector('iframe')
    expect(reloadedIframe).not.toBe(iframe)
    expect(reloadedIframe?.getAttribute('srcdoc')).toContain('Reloaded plugin')
    expect(watchdogStopMock).toHaveBeenCalledTimes(1)
    expect(watchdogStartMock).toHaveBeenCalledTimes(2)
  })

  it('remounts with fresh host theme tokens when the app theme changes', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<html class="__ORCA_COLOR_SCHEME__"><head><style>:root{/*__ORCA_PANEL_TOKENS__*/}</style></head>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:orca-samples.my-plugin/dashboard')
    const lightFrame = container.querySelector('iframe')
    expect(lightFrame?.getAttribute('srcdoc')).toContain('<html class="light">')

    await act(async () => {
      document.documentElement.classList.add('dark')
      await waitForHappyDomTasks()
    })

    const darkFrame = container.querySelector('iframe')
    expect(darkFrame).not.toBe(lightFrame)
    expect(darkFrame?.getAttribute('srcdoc')).toContain('<html class="dark">')
  })

  it('rebinds a refreshed session without remounting unchanged panel HTML', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:orca-samples.my-plugin/dashboard')
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
        type: 'orca-panel-action',
        requestId: 'request-one',
        action: 'notifications.show',
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
    await renderPanel('plugin:orca-samples.my-plugin/dashboard')

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

  it('shows an error state when the panel entry cannot be read', async () => {
    readPanelEntryMock.mockResolvedValue(null)

    await renderPanel('plugin:orca-samples.my-plugin/dashboard')

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('The plugin panel could not be loaded.')
  })

  it('recovers from a transient read failure with byte-identical HTML', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:orca-samples.my-plugin/dashboard')
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
      'plugin:orca-samples.my-plugin/dashboard',
      'healthy'
    )
  })

  it('publishes watchdog suspension to host-owned panel health state', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:orca-samples.my-plugin/dashboard')

    await act(async () => watchdogCallbacks.onUnresponsive?.())

    expect(setPanelHealthMock).toHaveBeenCalledWith(
      'plugin:orca-samples.my-plugin/dashboard',
      'error'
    )
    expect(container.textContent).toContain('stopped responding and was suspended')
  })

  it('keeps a watchdog error published when navigation unmounts the failed panel', async () => {
    readPanelEntryMock.mockResolvedValue({
      html: '<h1>Hello plugin</h1>',
      sessionToken: SESSION_TOKEN
    })
    await renderPanel('plugin:orca-samples.my-plugin/dashboard')
    setPanelHealthMock.mockClear()
    await act(async () => watchdogCallbacks.onUnresponsive?.())

    await act(async () => root.render(<div>Explorer</div>))

    expect(setPanelHealthMock).toHaveBeenCalledTimes(1)
    expect(setPanelHealthMock).toHaveBeenCalledWith(
      'plugin:orca-samples.my-plugin/dashboard',
      'error'
    )
  })

  it('shows an unavailable state for a tab whose plugin is gone', async () => {
    usePluginPanelsMock.mockReturnValue([])

    await renderPanel('plugin:orca-samples.removed-plugin/dashboard')

    expect(readPanelEntryMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This plugin panel is no longer available.')
  })

  it('treats a malformed plugin tab key as unavailable', async () => {
    await renderPanel('plugin:not-a-valid-key')

    expect(readPanelEntryMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This plugin panel is no longer available.')
  })
})
