/**
 * Reproduces the LAN web-client crash: served over plain HTTP, the browser
 * hides crypto.randomUUID and crypto.subtle (secure-context-only). This test
 * recreates that exact global shape and drives the real call sites.
 */
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
  it('crypto.randomUUID is undefined, like the browser reports', () => {
    // oxlint-disable-next-line no-restricted-properties -- asserting the absence this suite exists for
    expect((globalThis.crypto as Crypto).randomUUID).toBeUndefined()
    // oxlint-disable-next-line no-restricted-properties -- asserting the absence this suite exists for
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
      value: createNonSecureContextCrypto(realCrypto)
    })
    expect(await hashOrcaHookScript('echo hi')).toBe(secureHash)
  })

  // Regression for #19667: the store builds this sequencer at module load, so a throw here
  // white-screened the whole Remote Web client before anything painted.
  it('loads the renderer agent-status authority and its store slice', async () => {
    vi.resetModules()
    const { rendererAgentStatusObservations } = await import('./renderer-agent-status-observations')
    const { createAgentStatusAuthorityActions } =
      await import('../store/slices/agent-status-authority-actions')
    expect(typeof createAgentStatusAuthorityActions).toBe('function')
    expect(rendererAgentStatusObservations.getAuthorityId()).toMatch(
      /^renderer:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  // Naming two modules only pins today's crash. The reported stack was the whole store
  // chunk, so evaluate the store root: any new import-time secure-context call anywhere in
  // that graph fails here.
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
