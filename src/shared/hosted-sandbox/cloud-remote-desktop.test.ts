import { describe, expect, it } from 'vitest'
import { cloudRemoteDesktopUrl, isCloudRemoteDesktopUrl } from './cloud-remote-desktop'

describe('isCloudRemoteDesktopUrl', () => {
  it('recognizes the URL Orca builds for a desktop forward, on any port', () => {
    expect(isCloudRemoteDesktopUrl(cloudRemoteDesktopUrl(6080, 'vnc.html'))).toBe(true)
    expect(isCloudRemoteDesktopUrl(cloudRemoteDesktopUrl(51234, 'vnc.html'))).toBe(true)
  })

  it('rejects other localhost pages and anything with noVNC overrides', () => {
    expect(isCloudRemoteDesktopUrl('http://localhost:6080/vnc.html')).toBe(false)
    expect(isCloudRemoteDesktopUrl('http://localhost:3000/')).toBe(false)
    expect(
      isCloudRemoteDesktopUrl(
        'http://localhost:6080/vnc.html?autoconnect=0&reconnect=0&resize=remote&host=evil.test'
      )
    ).toBe(false)
    expect(
      isCloudRemoteDesktopUrl(
        'http://localhost:6080/vnc.html?autoconnect=0&reconnect=0&resize=remote#port=1'
      )
    ).toBe(false)
    expect(
      isCloudRemoteDesktopUrl(
        'https://example.com:6080/vnc.html?autoconnect=0&reconnect=0&resize=remote'
      )
    ).toBe(false)
    expect(isCloudRemoteDesktopUrl(null)).toBe(false)
    expect(isCloudRemoteDesktopUrl('not a url')).toBe(false)
  })
})
