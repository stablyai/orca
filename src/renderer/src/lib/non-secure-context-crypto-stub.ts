/**
 * Test-only shape of `globalThis.crypto` on a plain-HTTP origin: getRandomValues
 * survives, the secure-context-only members do not.
 *
 * Swapping the whole `crypto` own property is the only reversible way to do this.
 * `randomUUID` lives on `Crypto.prototype`, so stubbing it as an own property of
 * `globalThis.crypto` leaves nothing to restore and leaks into the rest of the file.
 */

/** The crypto object a browser exposes on a non-secure origin. */
export function createNonSecureContextCrypto(secureCrypto: Crypto = globalThis.crypto): {
  getRandomValues: Crypto['getRandomValues']
} {
  return { getRandomValues: secureCrypto.getRandomValues.bind(secureCrypto) }
}

/** Runs `body` with the non-secure crypto shape installed, restoring the real one after. */
export async function withNonSecureContextCrypto<T>(body: () => Promise<T> | T): Promise<T> {
  const secureCrypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: createNonSecureContextCrypto(secureCrypto)
  })
  try {
    return await body()
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: secureCrypto })
  }
}
