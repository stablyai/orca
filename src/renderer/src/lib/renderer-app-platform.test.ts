// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRendererAppPlatform,
  resetRendererAppPlatformCacheForTests
} from './renderer-app-platform'

function stubPlatformApi(get: () => { platform: NodeJS.Platform }): void {
  ;(window as unknown as { api: unknown }).api = { platform: { get } }
}

describe('getRendererAppPlatform', () => {
  beforeEach(() => {
    resetRendererAppPlatformCacheForTests()
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    resetRendererAppPlatformCacheForTests()
  })

  it('crosses the preload bridge once no matter how many renders ask', () => {
    const get = vi.fn(() => ({ platform: 'darwin' as NodeJS.Platform }))
    stubPlatformApi(get)

    for (let index = 0; index < 500; index += 1) {
      expect(getRendererAppPlatform()).toBe('darwin')
    }

    expect(get).toHaveBeenCalledTimes(1)
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'reports the preload platform verbatim on %s',
    (platform) => {
      stubPlatformApi(() => ({ platform }))

      expect(getRendererAppPlatform()).toBe(platform)
    }
  )

  // Why: the web client injects its platform API after boot, so an early caller must
  // not pin the user-agent guess for the rest of the session.
  it('does not cache the user-agent fallback', () => {
    // 'freebsd' is never a user-agent fallback answer, so the swap is unambiguous.
    expect(getRendererAppPlatform()).not.toBe('freebsd')

    stubPlatformApi(() => ({ platform: 'freebsd' }))

    expect(getRendererAppPlatform()).toBe('freebsd')
  })
})
