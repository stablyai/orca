import type { RuntimeHostDescriptor } from './runtime-host-descriptor'

/**
 * How a new pairing offer relates to a server this client already pairs with.
 * `pin` is the descriptor to keep pinned. `descriptor`:
 * - `pinned`: the offer's descriptor matches (or is now pinned for the first time).
 * - `moved`: same installation, different machine binding: the profile moved or was reinstalled.
 * - `unverifiable`: a pinned server now sends no descriptor (downgraded); the old pin is kept.
 * - `unpinned`: neither side has a descriptor yet.
 */
export type RuntimeHostRePairMatch =
  | {
      kind: 'same-host'
      pin: RuntimeHostDescriptor | undefined
      descriptor: 'pinned' | 'moved' | 'unverifiable' | 'unpinned'
    }
  | { kind: 'different-host' }

/**
 * The host key, which the pairing handshake proves, is the trust root: a different key is a
 * different server. The descriptor only separates a reinstall or a deliberate clone that kept the key.
 */
export function classifyRuntimeHostRePair(
  previous: { publicKeys: readonly string[]; pin?: RuntimeHostDescriptor },
  offer: { publicKeyB64: string; hostDescriptor?: RuntimeHostDescriptor }
): RuntimeHostRePairMatch {
  if (!previous.publicKeys.includes(offer.publicKeyB64)) {
    return { kind: 'different-host' }
  }
  const { pin } = previous
  const next = offer.hostDescriptor
  if (!next) {
    // Why keep the old pin: an older server must never let this client learn a replacement.
    return { kind: 'same-host', pin, descriptor: pin ? 'unverifiable' : 'unpinned' }
  }
  if (!pin) {
    return { kind: 'same-host', pin: next, descriptor: 'pinned' }
  }
  if (pin.installationId !== next.installationId) {
    return { kind: 'different-host' }
  }
  const moved =
    pin.machineBinding !== undefined &&
    next.machineBinding !== undefined &&
    pin.machineBinding !== next.machineBinding
  return { kind: 'same-host', pin: next, descriptor: moved ? 'moved' : 'pinned' }
}
