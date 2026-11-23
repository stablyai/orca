import type { PairedE2EEFraming, PairedE2EELegacyGate } from './paired-e2ee-client-handshake'

// Persist per-host v2 success by pinned public key; platform adapters own storage.
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
    // Legacy fallback is allowed only for never-v2 hosts refusing direct v2; otherwise it is a downgrade.
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
