import { describe, expect, it } from 'vitest'
import {
  canMintMobilePairingOffer,
  effectiveMobilePairingConnectionMode,
  resolveMobilePairingConnectionMode
} from './mobile-pairing-connection-mode'

describe('mobile pairing connection mode defaults', () => {
  it('defaults to Anywhere when no preference is saved', () => {
    expect(resolveMobilePairingConnectionMode(undefined)).toBe('automatic')
    expect(resolveMobilePairingConnectionMode(null)).toBe('automatic')
  })

  it('keeps an explicit same-network preference', () => {
    expect(resolveMobilePairingConnectionMode('local-only')).toBe('local-only')
  })

  it('keeps an explicit Anywhere preference', () => {
    expect(resolveMobilePairingConnectionMode('automatic')).toBe('automatic')
  })

  it('cannot commit Anywhere into a QR while signed out', () => {
    expect(effectiveMobilePairingConnectionMode({ preferred: 'automatic', signedIn: false })).toBe(
      'local-only'
    )
    expect(effectiveMobilePairingConnectionMode({ preferred: 'automatic', signedIn: true })).toBe(
      'automatic'
    )
    expect(effectiveMobilePairingConnectionMode({ preferred: 'local-only', signedIn: false })).toBe(
      'local-only'
    )
  })

  it('refuses to mint under signed-out Anywhere and allows honest paths', () => {
    // Why: mint refusal is the UI honesty gate that replaces silent degradation
    // for renderer mint paths (signed-out Anywhere must not show a local QR).
    expect(canMintMobilePairingOffer({ connectionMode: 'automatic', signedIn: false })).toBe(false)
    expect(canMintMobilePairingOffer({ connectionMode: 'automatic', signedIn: true })).toBe(true)
    expect(canMintMobilePairingOffer({ connectionMode: 'local-only', signedIn: false })).toBe(true)
    expect(canMintMobilePairingOffer({ connectionMode: 'local-only', signedIn: true })).toBe(true)
  })
})
