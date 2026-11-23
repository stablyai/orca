// A released tab strip keeps its owner's answer, as its still-mounted subscription did before release.
const heldOwnerKeyByReleasedStrip = new Map<string, string>()
const releasedStripHoldsByOwnerKey = new Map<string, number>()
const MAX_RELEASED_STRIP_HOLDS = 8192

export function holdWindowsTerminalCapabilitiesForReleasedStrip(
  stripKey: string,
  ownerKey: string
): void {
  releaseWindowsTerminalCapabilityHold(stripKey)
  heldOwnerKeyByReleasedStrip.set(stripKey, ownerKey)
  releasedStripHoldsByOwnerKey.set(ownerKey, (releasedStripHoldsByOwnerKey.get(ownerKey) ?? 0) + 1)
  const oldest = heldOwnerKeyByReleasedStrip.keys().next()
  if (heldOwnerKeyByReleasedStrip.size > MAX_RELEASED_STRIP_HOLDS && !oldest.done) {
    releaseWindowsTerminalCapabilityHold(oldest.value)
  }
}

export function releaseWindowsTerminalCapabilityHold(stripKey: string): void {
  const ownerKey = heldOwnerKeyByReleasedStrip.get(stripKey)
  if (ownerKey === undefined) {
    return
  }
  heldOwnerKeyByReleasedStrip.delete(stripKey)
  const holds = (releasedStripHoldsByOwnerKey.get(ownerKey) ?? 1) - 1
  if (holds > 0) {
    releasedStripHoldsByOwnerKey.set(ownerKey, holds)
  } else {
    releasedStripHoldsByOwnerKey.delete(ownerKey)
  }
}

export function isWindowsTerminalCapabilityOwnerHeld(ownerKey: string): boolean {
  return releasedStripHoldsByOwnerKey.has(ownerKey)
}
