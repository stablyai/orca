// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  // The web platform bridge arrives after boot; early user-agent guesses must not become session-long cache entries.
  it('does not cache the user-agent fallback', () => {
    // 'freebsd' is never a user-agent fallback answer, so the swap is unambiguous.
    expect(getRendererAppPlatform()).not.toBe('freebsd')

    stubPlatformApi(() => ({ platform: 'freebsd' }))

    expect(getRendererAppPlatform()).toBe('freebsd')
  })
})
