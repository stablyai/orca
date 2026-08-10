import type { DetectedPort } from './ssh-types'

/** True when any row carries ownership metadata from a modern Linux relay. */
export function sshDetectedPortOwnershipFilteringActive(
  ports: readonly Pick<DetectedPort, 'ownedByConnectingUser'>[]
): boolean {
  return ports.some((port) => port.ownedByConnectingUser !== undefined)
}

/**
 * Panel visibility for a detected SSH port.
 * Old relays / Windows leave ownership unset → no filter (show all).
 * Never hide ports advertised from the user's own terminal.
 */
export function shouldIncludeSshDetectedPortInPanel(
  port: Pick<DetectedPort, 'ownedByConnectingUser'> & { advertisedUrl?: string },
  options: { showOtherUsers: boolean; ownershipFilteringActive: boolean }
): boolean {
  if (!options.ownershipFilteringActive || options.showOtherUsers) {
    return true
  }
  if (port.advertisedUrl) {
    return true
  }
  return port.ownedByConnectingUser !== false
}

/** Auto-forward may only target owned ports when ownership is known. */
export function isSshAutoForwardOwnedPort(
  port: Pick<DetectedPort, 'ownedByConnectingUser'>
): boolean {
  return port.ownedByConnectingUser !== false
}

export function filterSshAutoForwardCandidates(
  ports: readonly DetectedPort[],
  initialPorts: ReadonlySet<string>
): DetectedPort[] {
  return ports.filter((port) => {
    if (initialPorts.has(`${port.host}:${port.port}`)) {
      return false
    }
    return isSshAutoForwardOwnedPort(port)
  })
}
