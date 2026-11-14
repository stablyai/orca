/** Model plain-HTTP crypto with getRandomValues only. Replace/restore the whole property: randomUUID lives on Crypto.prototype, so own-property stubbing cannot reliably unwind it. */

export function createNonSecureContextCrypto(secureCrypto: Crypto = globalThis.crypto): {
  getRandomValues: Crypto['getRandomValues']
} {
  return { getRandomValues: secureCrypto.getRandomValues.bind(secureCrypto) }
}

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
