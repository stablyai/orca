import type { PairedE2EEFraming, PairedE2EELegacyGate } from './paired-e2ee-client-handshake'

// Per-host record of hosts that completed a v2 handshake, keyed by the pinned
// host public key (not a secret). Persistence is the platform's concern.
export type PairedE2EEV2LatchStore = {
  hydrate: () => Promise<void>
  // null = not hydrated yet; callers must then treat the host as latched.
  isLatched: (hostPublicKeyB64: string) => boolean | null
  latch: (hostPublicKeyB64: string) => void
}

export type PairedE2EEFramingPolicy = PairedE2EELegacyGate & {
  framingForNextDial: () => PairedE2EEFraming
  // Only a latched host refusing a v2 hello is an auth verdict; otherwise it is an old host.
  helloRefusalIsAuthFailure: () => boolean
  noteV2Authenticated: () => void
  noteV2HelloRefused: () => void
}

export function createPairedE2EEFramingPolicy(
  hostPublicKeyB64: string,
  store: PairedE2EEV2LatchStore
): PairedE2EEFramingPolicy {
  void store.hydrate()
  let helloRefused = false
  const mayUseLegacy = (): boolean => store.isLatched(hostPublicKeyB64) === false
  return {
    // Why: only a host never seen speaking v2 that refused a v2 hello predates
    // direct v2; anything else falling back would be a downgrade.
    framingForNextDial: () => (helloRefused && mayUseLegacy() ? 'legacy' : 'v2'),
    mayUseLegacy,
    helloRefusalIsAuthFailure: () => store.isLatched(hostPublicKeyB64) === true,
    noteV2Authenticated: () => {
      helloRefused = false
      store.latch(hostPublicKeyB64)
    },
    noteV2HelloRefused: () => {
      helloRefused = true
      void store.hydrate()
    }
  }
}
