// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  desktopRendererLoaded: vi.fn()
}))

vi.mock('./desktop-renderer', () => {
  mocks.desktopRendererLoaded()
  return {}
})

describe('desktop renderer entry', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined
    })
    mocks.desktopRendererLoaded.mockClear()
  })

  it('defers the desktop module when the preload bridge is absent', async () => {
    await import('./main')

    expect(mocks.desktopRendererLoaded).not.toHaveBeenCalled()
    expect(document.getElementById('root')?.textContent).toContain(
      'Open this page from the Orca app.'
    )
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/web-index.html')
  })
})
