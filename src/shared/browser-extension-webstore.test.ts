import { describe, expect, it } from 'vitest'
import {
  isChromeWebStoreUrl,
  parseChromeWebStoreExtensionInput
} from './browser-extension-webstore'

const BITWARDEN = 'nngceckbapebfimnlniiiahkandclblb'

describe('parseChromeWebStoreExtensionInput', () => {
  it.each([
    BITWARDEN,
    `  ${BITWARDEN.toUpperCase()}  `,
    `https://chromewebstore.google.com/detail/bitwarden-password-manage/${BITWARDEN}`,
    `https://chromewebstore.google.com/detail/bitwarden-password-manage/${BITWARDEN}?hl=en&pli=1`,
    `https://chromewebstore.google.com/detail/${BITWARDEN}`,
    `chromewebstore.google.com/detail/bitwarden/${BITWARDEN}#reviews`,
    `https://chrome.google.com/webstore/detail/bitwarden/${BITWARDEN}`
  ])('reads the id from %s', (input) => {
    expect(parseChromeWebStoreExtensionInput(input)).toBe(BITWARDEN)
  })

  it.each([
    '',
    'bitwarden',
    BITWARDEN.slice(1),
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    `http://chromewebstore.google.com/detail/bitwarden/${BITWARDEN}`,
    `https://chromewebstore.google.com.evil.tld/detail/bitwarden/${BITWARDEN}`,
    `https://evil.tld/chromewebstore.google.com/detail/bitwarden/${BITWARDEN}`,
    `https://user@chromewebstore.google.com/detail/bitwarden/${BITWARDEN}`,
    `https://chromewebstore.google.com/search/${BITWARDEN}`,
    `https://addons.mozilla.org/detail/${BITWARDEN}`
  ])('rejects %j', (input) => {
    expect(parseChromeWebStoreExtensionInput(input)).toBeNull()
  })
})

describe('isChromeWebStoreUrl', () => {
  it('accepts only the exact store origin', () => {
    expect(isChromeWebStoreUrl(`https://chromewebstore.google.com/detail/x/${BITWARDEN}`)).toBe(
      true
    )
    expect(isChromeWebStoreUrl('https://chromewebstore.google.com')).toBe(true)
    for (const url of [
      'https://chromewebstore.google.com.evil.tld/',
      'https://evil.chromewebstore.google.com/',
      'http://chromewebstore.google.com/',
      'https://chromewebstore.google.com:8443/',
      'https://evil.tld/?https://chromewebstore.google.com',
      'chrome-extension://chromewebstore.google.com/',
      'not a url'
    ]) {
      expect(isChromeWebStoreUrl(url), url).toBe(false)
    }
  })
})
