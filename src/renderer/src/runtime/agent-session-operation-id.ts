function randomOperationNonce(): string {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) {
    // Why: a weak nonce can collide across clients and turn distinct launches
    // into the same idempotent operation, so fail instead of using Math.random.
    throw new Error('Secure randomness is unavailable for this agent launch.')
  }
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createAgentSessionOperationId(now = Date.now()): string {
  return `${now}-${randomOperationNonce()}`
}
