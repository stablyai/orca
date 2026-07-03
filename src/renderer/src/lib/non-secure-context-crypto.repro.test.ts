/**
 * Reproduces the LAN web-client crash: served over plain HTTP, the browser
 * hides crypto.randomUUID and crypto.subtle (secure-context-only). This test
 * recreates that exact global shape and drives the real call sites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const realCrypto = globalThis.crypto

beforeEach(() => {
  // Match a non-secure browser context: getRandomValues stays, the
  // secure-context-only members are undefined.
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto)
    }
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto })
})

describe('non-secure context (plain HTTP LAN web client)', () => {
  it('crypto.randomUUID is undefined, like the browser reports', () => {
    expect((globalThis.crypto as Crypto).randomUUID).toBeUndefined()
    expect(() => (globalThis.crypto as Crypto).randomUUID()).toThrow()
  })

  it('hashOrcaHookScript does not throw when crypto.subtle is missing', async () => {
    const { hashOrcaHookScript } = await import('./orca-hook-trust')
    const hash = await hashOrcaHookScript('echo hi')
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  // The fallback must match the secure-context hash, or the shared trust store
  // mismatches and the user is re-prompted to approve a hook they already
  // trusted on the desktop app.
  it('produces the same hash as crypto.subtle did in a secure context', async () => {
    const { hashOrcaHookScript } = await import('./orca-hook-trust')
    const secureHash = await (async () => {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto })
      return hashOrcaHookScript('echo hi')
    })()
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }
    })
    expect(await hashOrcaHookScript('echo hi')).toBe(secureHash)
  })

  it('createBrowserUuid does not throw when randomUUID is missing', async () => {
    const { createBrowserUuid } = await import('./browser-uuid')
    expect(createBrowserUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })
})
