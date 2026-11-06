// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isWebClientLocation } = vi.hoisted(() => ({ isWebClientLocation: vi.fn() }))
vi.mock('../lib/web-client-location', () => ({ isWebClientLocation }))

beforeEach(() => {
  vi.resetModules()
  isWebClientLocation.mockReturnValue(false)
  Object.defineProperty(navigator, 'languages', { configurable: true, value: ['fr-FR', 'en-US'] })
})

function installBridge(
  getSystemLanguageDetection?: (browserPreferences?: readonly string[]) => Promise<unknown>
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { app: { getSystemLanguageDetection } }
  })
}

afterEach(() => vi.useRealTimers())

describe('client-local startup language', () => {
  it('uses uncertain browser fallback when an older bridge lacks the optional snapshot', async () => {
    installBridge()
    const { initializeLanguageDetection } = await import('./language-readiness')
    expect(await initializeLanguageDetection()).toMatchObject({
      detectedTag: 'fr-FR',
      locale: 'fr',
      source: 'browser-fallback'
    })
  })

  it('uses browser preferences on web/mobile without asking the server for its locale', async () => {
    isWebClientLocation.mockReturnValue(true)
    const probe = vi.fn()
    installBridge(probe)
    const { initializeLanguageDetection } = await import('./language-readiness')
    expect(await initializeLanguageDetection()).toMatchObject({ locale: 'fr', source: 'browser' })
    expect(probe).not.toHaveBeenCalled()
  })
})

it('bounds startup with browser fallback and reconciles a late native result', async () => {
  vi.useFakeTimers()
  let finish: (value: unknown) => void = () => {}
  installBridge(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { initializeLanguageDetection, useLanguageReadiness } = await import('./language-readiness')
  const detection = initializeLanguageDetection()
  await vi.advanceTimersByTimeAsync(1000)
  expect(await detection).toMatchObject({ locale: 'fr', source: 'browser-fallback' })
  finish({ detectedTag: 'ja-JP', locale: 'ja', status: 'supported', source: 'native' })
  await Promise.resolve()
  expect(useLanguageReadiness.getState().detection).toMatchObject({
    locale: 'ja',
    source: 'native'
  })
  const { getRendererLanguageDetection } = await import('../../../shared/ui-locale')
  expect(getRendererLanguageDetection().locale).toBe('ja')
  expect(await initializeLanguageDetection()).toMatchObject({ locale: 'ja', source: 'native' })
})
