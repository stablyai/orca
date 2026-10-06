import { expect, it } from 'vitest'
import { cleanCloudServiceOrigin } from './cloud-service-url'
it.each(['ftp://localhost', 'file://localhost', 'ws://localhost', 'http://example.com'])(
  'rejects %s even with the development loopback exception',
  (url) => {
    expect(cleanCloudServiceOrigin(url, true)).toBeNull()
  }
)
it('allows HTTP only for explicitly enabled loopback development', () => {
  expect(cleanCloudServiceOrigin('http://localhost:8080', true)).toBe('http://localhost:8080')
  expect(cleanCloudServiceOrigin('http://localhost:8080', false)).toBeNull()
  expect(cleanCloudServiceOrigin('https://push.onorca.dev', false)).toBe('https://push.onorca.dev')
})
