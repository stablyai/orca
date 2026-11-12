import { describe, expect, it } from 'vitest'
import {
  isSameExtensionNavigation,
  resolveBrowserExtensionRequestedUrl
} from './browser-extension-url'

const CALLER = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

describe('resolveBrowserExtensionRequestedUrl', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'chrome://settings',
    'chrome-extension://not-an-id/page.html'
  ])('refuses %s', (raw) => {
    expect(resolveBrowserExtensionRequestedUrl(raw, CALLER)).toBeNull()
  })
})

describe('extension page navigation rules', () => {
  it('lets an extension page move only within its own extension', () => {
    expect(
      isSameExtensionNavigation(
        `chrome-extension://${CALLER}/a.html`,
        `chrome-extension://${CALLER}/b.html`
      )
    ).toBe(true)
    expect(
      isSameExtensionNavigation(
        `chrome-extension://${CALLER}/a.html`,
        `chrome-extension://${OTHER}/b.html`
      )
    ).toBe(false)
    expect(
      isSameExtensionNavigation('https://example.com/', `chrome-extension://${CALLER}/b.html`)
    ).toBe(false)
  })
})
