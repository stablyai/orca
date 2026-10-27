/** Exercise real call sites with plain-HTTP crypto shape: LAN clients lack randomUUID/subtle. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  // Import-time sequencer creation once white-screened LAN clients before rendering (#19667).
  it('loads the renderer agent-status authority and its store slice', async () => {
    vi.resetModules()
    const { rendererAgentStatusObservations } = await import('./renderer-agent-status-observations')
    await import('../store/slices/agent-status/agent-status-authority-actions')
    expect(rendererAgentStatusObservations.getAuthorityId()).toMatch(
      /^renderer:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  // Evaluate the whole store graph so future import-time secure-context calls fail too.
  it('evaluates the whole store graph', async () => {
    vi.resetModules()
    const { useAppStore } = await import('@/store')
    expect(typeof useAppStore.getState).toBe('function')
  })

  it('createBrowserUuid does not throw when randomUUID is missing', async () => {
    const { createBrowserUuid } = await import('./browser-uuid')
    expect(createBrowserUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })
})
