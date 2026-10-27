import { describe, expect, it } from 'vitest'
import {
  canMintMobilePairingOffer,
  effectiveMobilePairingConnectionMode,
  isMobilePairingRelayDisabled,
  parseMobilePairingConnectionMode,
  resolveMobilePairingConnectionMode
} from './mobile-pairing-connection-mode'

describe('mobile pairing connection mode defaults', () => {
  it('preselects LAN on a signed-out desktop, even with the persisted Anywhere default', () => {
    for (const saved of [undefined, null, 'automatic', 'local-only'] as const) {
      expect(resolveMobilePairingConnectionMode(saved, { signedIn: false })).toBe('local-only')
    }
  })

  it('defaults a signed-in desktop to Anywhere', () => {
    expect(resolveMobilePairingConnectionMode(undefined, { signedIn: true })).toBe('automatic')
    expect(resolveMobilePairingConnectionMode('automatic', { signedIn: true })).toBe('automatic')
  })

  it('keeps an explicit same-network preference after sign-in', () => {
    expect(resolveMobilePairingConnectionMode('local-only', { signedIn: true })).toBe('local-only')
  })

  it('keeps an explicit Iroh preference whether or not the desktop is signed in', () => {
    expect(resolveMobilePairingConnectionMode('iroh', { signedIn: false })).toBe('iroh')
    expect(resolveMobilePairingConnectionMode('iroh', { signedIn: true })).toBe('iroh')
  })

  it('degrades unknown modes to Anywhere (backward-tolerant decode)', () => {
    expect(parseMobilePairingConnectionMode('future-mode')).toBe('automatic')
    expect(parseMobilePairingConnectionMode(42)).toBe('automatic')
    expect(parseMobilePairingConnectionMode({ mode: 'iroh' })).toBe('automatic')
  })

  it('treats local-only and iroh as relay-disabled', () => {
    expect(isMobilePairingRelayDisabled('local-only')).toBe(true)
    expect(isMobilePairingRelayDisabled('iroh')).toBe(true)
    expect(isMobilePairingRelayDisabled('automatic')).toBe(false)
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
    expect(effectiveMobilePairingConnectionMode({ preferred: 'iroh', signedIn: false })).toBe(
      'iroh'
    )
  })

  it('refuses to mint under signed-out Anywhere and allows honest paths', () => {
    // Signed-out Anywhere must refuse minting rather than display a misleading local QR.
    expect(canMintMobilePairingOffer({ connectionMode: 'automatic', signedIn: false })).toBe(false)
    expect(canMintMobilePairingOffer({ connectionMode: 'automatic', signedIn: true })).toBe(true)
    expect(canMintMobilePairingOffer({ connectionMode: 'local-only', signedIn: false })).toBe(true)
    expect(canMintMobilePairingOffer({ connectionMode: 'local-only', signedIn: true })).toBe(true)
    expect(canMintMobilePairingOffer({ connectionMode: 'iroh', signedIn: false })).toBe(true)
    expect(canMintMobilePairingOffer({ connectionMode: 'iroh', signedIn: true })).toBe(true)
  })
})
