import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRendererAppPlatform, isMacOs } from './renderer-app-platform'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getRendererAppPlatform', () => {
  it('uses the preload-reported platform ahead of the renderer user agent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })
    vi.stubGlobal('window', {
      api: { platform: { get: () => ({ platform: 'darwin' as const }) } }
    })

    expect(getRendererAppPlatform()).toBe('darwin')
    expect(isMacOs()).toBe(true)
  })

  it.each([
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'win32' },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'darwin' },
    { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'linux' }
  ] as const)(
    'uses the user agent when preload is unavailable: $platform',
    ({ userAgent, platform }) => {
      vi.stubGlobal('navigator', { userAgent })
      vi.stubGlobal('window', undefined)

      expect(getRendererAppPlatform()).toBe(platform)
    }
  )

  it('uses the stable Windows fallback without browser globals', () => {
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('window', undefined)

    expect(getRendererAppPlatform()).toBe('win32')
    expect(isMacOs()).toBe(false)
  })
})
