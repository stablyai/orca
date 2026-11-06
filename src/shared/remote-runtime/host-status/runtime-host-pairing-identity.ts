import type { RuntimeHostDescriptor } from './runtime-host-descriptor'

/** Retain the pin: pinned matches/newly pins; moved changes binding on the same installation;
 * unverifiable keeps a missing descriptor’s prior pin; unpinned means neither has one. */
export type RuntimeHostRePairMatch =
  | {
      kind: 'same-host'
      pin: RuntimeHostDescriptor | undefined
      descriptor: 'pinned' | 'moved' | 'unverifiable' | 'unpinned'
    }
  | { kind: 'different-host' }

/** Handshake-proven host keys anchor trust; descriptors distinguish reinstalls/clones retaining the key. */
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
