// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { captureChrome } from './plugin-view-chrome-capture'

vi.mock('./plugin-view-panel-settle', () => ({
  nextPaintedFrames: async () => undefined,
  waitForColorScheme: async () => undefined
}))

afterEach(() => {
  usePluginViewCaptureStore.getState().end()
  document.body.innerHTML = ''
})

describe("a capture of Orca's chrome", () => {
  it('measures the status bar, painting the asked theme for the capture', async () => {
    const bar = document.createElement('div')
    bar.setAttribute('data-orca-status-bar', '')
    bar.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 876, width: 800, height: 24 })
    document.body.append(bar)
    const reply = await captureChrome({
      requestId: 'r',
      kind: 'capture-chrome',
      region: 'status-bar',
      colorScheme: 'dark'
    })
    expect(usePluginViewCaptureStore.getState()).toMatchObject({ dark: true, capturing: true })
    expect(reply).toMatchObject({
      ok: true,
      panel: { rect: { x: 0, y: 876, width: 800, height: 24 }, guestUrl: null }
    })
  })

  it('refuses a hidden status bar, and measures the whole window for --window', async () => {
    await expect(
      captureChrome({ requestId: 'r', kind: 'capture-chrome', region: 'status-bar' })
    ).resolves.toMatchObject({
      ok: false,
      code: 'chrome_hidden'
    })
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1200
    })
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 800
    })
    await expect(
      captureChrome({ requestId: 'r', kind: 'capture-chrome', region: 'window' })
    ).resolves.toMatchObject({
      ok: true,
      panel: { rect: { x: 0, y: 0, width: 1200, height: 800 } }
    })
  })
})
