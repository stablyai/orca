import { describe, expect, it } from 'vitest'
import { parseChromeWebStoreExtensionInput } from './browser-extension-webstore'

const BITWARDEN = 'nngceckbapebfimnlniiiahkandclblb'

describe('parseChromeWebStoreExtensionInput', () => {
  it.each([
    `http://chromewebstore.google.com/detail/bitwarden/${BITWARDEN}`,
    `https://chromewebstore.google.com.evil.tld/detail/bitwarden/${BITWARDEN}`,
    `https://user@chromewebstore.google.com/detail/bitwarden/${BITWARDEN}`,
    `https://chromewebstore.google.com/search/${BITWARDEN}`
  ])('rejects %j', (input) => {
    expect(parseChromeWebStoreExtensionInput(input)).toBeNull()
  })
})
