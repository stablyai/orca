import { describe, expect, it } from 'vitest'
import {
  isSameExtensionNavigation,
  normalizeBrowserGuestSrc,
  resolveBrowserExtensionRequestedUrl
} from './browser-extension-url'
import { ORCA_BROWSER_BLANK_URL } from './constants'

const CALLER = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

describe('resolveBrowserExtensionRequestedUrl', () => {
  it.each([
    [undefined, { kind: 'blank', url: ORCA_BROWSER_BLANK_URL }],
    ['about:blank', { kind: 'blank', url: ORCA_BROWSER_BLANK_URL }],
    [
      'popup/index.html?x=1',
      {
        kind: 'extension',
        extensionId: CALLER,
        url: `chrome-extension://${CALLER}/popup/index.html?x=1`
      }
    ],
    [
      '/options.html',
      { kind: 'extension', extensionId: CALLER, url: `chrome-extension://${CALLER}/options.html` }
    ],
    [
      `chrome-extension://${OTHER}/page.html`,
      { kind: 'extension', extensionId: OTHER, url: `chrome-extension://${OTHER}/page.html` }
    ],
    ['https://vault.example.com/#/login', { kind: 'web', url: 'https://vault.example.com/#/login' }]
  ])('resolves %s', (raw, expected) => {
    expect(resolveBrowserExtensionRequestedUrl(raw, CALLER)).toEqual(expected)
  })

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

  it('admits extension pages as webview src while keeping typed-URL rules for everything else', () => {
    expect(normalizeBrowserGuestSrc(`chrome-extension://${CALLER}/options.html`)).toBe(
      `chrome-extension://${CALLER}/options.html`
    )
    expect(normalizeBrowserGuestSrc('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserGuestSrc('javascript:alert(1)')).toBeNull()
  })
})
