import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'

export const RELAY_VERSION_MARKER_MAX_BYTES = 4 * 1024

export function readRelayVersionMarkerSync(versionFile: string): string {
  return readNodeFileSyncWithinLimit(versionFile, RELAY_VERSION_MARKER_MAX_BYTES)
    .buffer.toString('utf8')
    .trim()
}
