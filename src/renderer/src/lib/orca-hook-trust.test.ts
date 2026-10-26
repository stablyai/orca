import { afterEach, describe, expect, it } from 'vitest'
import { hashOrcaHookScript } from './orca-hook-trust'

const realCrypto = globalThis.crypto

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
})

function stubCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true })
}

describe('hashOrcaHookScript', () => {
  it('produces a stable hex digest via crypto.subtle', async () => {
    const hash = await hashOrcaHookScript('echo hi')
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(await hashOrcaHookScript('  echo hi  ')).toBe(hash)
  })

  // Plain-HTTP LAN clients lack crypto.subtle; fallback must still produce deterministic matching trust hashes.
  it('falls back to a deterministic hash when crypto.subtle is unavailable', async () => {
    stubCrypto(undefined)
    const hash = await hashOrcaHookScript('echo hi')
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(await hashOrcaHookScript('echo hi')).toBe(hash)
    expect(await hashOrcaHookScript('echo bye')).not.toBe(hash)
  })
})
