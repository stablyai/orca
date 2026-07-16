// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDesktopRenderer } from './desktop-renderer-bootstrap'

afterEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: undefined
  })
})

describe('bootstrapDesktopRenderer', () => {
  it('does not load the desktop app when the preload bridge is absent', async () => {
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const loadDesktopRenderer = vi.fn(async () => vi.fn())

    startDesktopRenderer({
      rootElement,
      preloadBridgeAvailable: false,
      loadDesktopRenderer,
      webClientPath: '/web-index.html'
    })

    expect(loadDesktopRenderer).not.toHaveBeenCalled()
    expect(rootElement.textContent).toContain('Open this page from the Orca app.')
    expect(rootElement.querySelector('a')).toMatchObject({
      pathname: '/web-index.html'
    })
  })

  it('loads the desktop app when the preload bridge is available', async () => {
    const rootElement = document.createElement('div')
    const mountDesktopRenderer = vi.fn()
    const loadDesktopRenderer = vi.fn(async () => mountDesktopRenderer)

    startDesktopRenderer({
      rootElement,
      preloadBridgeAvailable: true,
      loadDesktopRenderer,
      webClientPath: '/web-index.html'
    })

    await vi.waitFor(() => expect(loadDesktopRenderer).toHaveBeenCalledOnce())
    expect(mountDesktopRenderer).toHaveBeenCalledWith(rootElement)
    expect(rootElement.childElementCount).toBe(0)
  })

  it('records a missing root at the bootstrap ownership seam', async () => {
    const recordBreadcrumb = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { crashReports: { recordBreadcrumb } }
    })

    startDesktopRenderer({
      rootElement: null,
      preloadBridgeAvailable: false,
      loadDesktopRenderer: async () => () => undefined,
      webClientPath: null
    })

    await vi.waitFor(() =>
      expect(recordBreadcrumb).toHaveBeenCalledWith({ name: 'renderer_root_missing' })
    )
  })

  it('renders a retry surface when the desktop module cannot load', async () => {
    const rootElement = document.createElement('div')

    startDesktopRenderer({
      rootElement,
      preloadBridgeAvailable: true,
      loadDesktopRenderer: async () => {
        throw new Error('chunk unavailable')
      },
      webClientPath: '/web-index.html'
    })

    await vi.waitFor(() => expect(rootElement.textContent).toContain('Orca could not start.'))
    expect(rootElement.textContent).toContain('The desktop renderer could not load.')
    expect(rootElement.querySelector('button')?.textContent).toBe('Retry')
  })
})
