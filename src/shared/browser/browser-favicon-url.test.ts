import { describe, expect, it } from 'vitest'
import { remoteTabFaviconUrl } from './browser-favicon-url'

describe('remoteTabFaviconUrl', () => {
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
})
