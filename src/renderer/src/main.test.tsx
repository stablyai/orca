// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  desktopRendererLoaded: vi.fn(),
  rejectDesktopRenderer: false
}))

vi.mock('./desktop-renderer', () => {
  mocks.desktopRendererLoaded()
  if (mocks.rejectDesktopRenderer) {
    throw new Error('desktop chunk unavailable')
  }
  return { mountDesktopRenderer: vi.fn() }
})

describe('desktop renderer entry', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = '<div id="root"></div>'
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined
    })
    mocks.desktopRendererLoaded.mockClear()
    mocks.rejectDesktopRenderer = false
  })

  it('defers the desktop module when the preload bridge is absent', async () => {
    await import('./main')

    expect(mocks.desktopRendererLoaded).not.toHaveBeenCalled()
    expect(document.getElementById('root')?.textContent).toContain(
      'Open this page from the Orca app.'
    )
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/web-index.html')
  })

  it('renders a recovery surface when the deferred desktop import rejects', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {}
    })
    mocks.rejectDesktopRenderer = true

    await import('./main')

    await vi.waitFor(() => {
      expect(document.getElementById('root')?.textContent).toContain('Orca could not start.')
    })
    expect(mocks.desktopRendererLoaded).toHaveBeenCalledOnce()
    expect(document.querySelector('button')?.textContent).toBe('Retry')
  })
})
