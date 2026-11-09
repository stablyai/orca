import { describe, expect, it } from 'vitest'
import { remoteTabFaviconUrl } from './browser-favicon-url'

describe('remoteTabFaviconUrl', () => {
  it('publishes public icons and small inline icons', () => {
    expect(remoteTabFaviconUrl('https://www.onorca.dev/favicon.ico?v=1')).toBe(
      'https://www.onorca.dev/favicon.ico?v=1'
    )
    expect(remoteTabFaviconUrl('http://192.168.1.20:3000/icon.png')).toBe(
      'http://192.168.1.20:3000/icon.png'
    )
    expect(remoteTabFaviconUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  it('drops icons only the host can reach', () => {
    for (const url of [
      'http://localhost:5173/favicon.ico',
      'http://127.0.0.1:3000/icon.png',
      'http://[::1]:8080/favicon.ico',
      'http://0.0.0.0:3000/favicon.ico',
      'https://app.localhost/favicon.ico',
      'http://[::ffff:127.0.0.1]:3000/favicon.ico'
    ]) {
      expect(remoteTabFaviconUrl(url)).toBeNull()
    }
  })

  it('drops inline icons over the size cap', () => {
    expect(remoteTabFaviconUrl(`data:image/png;base64,${'A'.repeat(2048)}`)).toBeNull()
  })
})
