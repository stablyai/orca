import { accessSync, constants, statSync } from 'node:fs'

const MACPORTS_PORT_PATH = '/opt/local/bin/port'

/**
 * Default-prefix MacPorts sentinel. GUI PATH will not contain `/opt/local` yet,
 * so a PATH lookup cannot see it. Only `/opt/local/bin/port` — a custom prefix
 * under `/usr/local` is already on the seed.
 */
export function isMacPortsPortExecutablePresent(): boolean {
  try {
    if (!statSync(MACPORTS_PORT_PATH).isFile()) {
      return false
    }
    accessSync(MACPORTS_PORT_PATH, constants.X_OK)
    return true
  } catch {
    return false
  }
}
