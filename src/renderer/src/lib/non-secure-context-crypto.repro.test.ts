/** Exercise real call sites with plain-HTTP crypto shape: LAN clients lack randomUUID/subtle. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNonSecureContextCrypto } from './non-secure-context-crypto-stub'

const realCrypto = globalThis.crypto

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: createNonSecureContextCrypto(realCrypto)
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto })
})

describe('non-secure context (plain HTTP LAN web client)', () => {
  // Fallback hashes must match secure-context hashes or previously approved hook trust would mismatch.
  it('produces the same hash as crypto.subtle did in a secure context', async () => {
    const { hashOrcaHookScript } = await import('./orca-hook-trust')
    const secureHash = await (async () => {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto })
      return hashOrcaHookScript('echo hi')
    })()
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: createNonSecureContextCrypto(realCrypto)
    })
    expect(await hashOrcaHookScript('echo hi')).toBe(secureHash)
  })
})
