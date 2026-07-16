// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapDesktopRenderer } from './desktop-renderer-bootstrap'

afterEach(() => {
  document.body.replaceChildren()
})

describe('bootstrapDesktopRenderer', () => {
  it('does not load the desktop app when the preload bridge is absent', async () => {
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const loadDesktopRenderer = vi.fn(async () => undefined)

    await bootstrapDesktopRenderer({
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
    const loadDesktopRenderer = vi.fn(async () => undefined)

    await bootstrapDesktopRenderer({
      rootElement,
      preloadBridgeAvailable: true,
      loadDesktopRenderer,
      webClientPath: '/web-index.html'
    })

    expect(loadDesktopRenderer).toHaveBeenCalledOnce()
    expect(rootElement.childElementCount).toBe(0)
  })

  it('fails fast when the renderer root is missing', async () => {
    await expect(
      bootstrapDesktopRenderer({
        rootElement: null,
        preloadBridgeAvailable: false,
        loadDesktopRenderer: async () => undefined,
        webClientPath: null
      })
    ).rejects.toThrow('Renderer root element not found.')
  })
})
