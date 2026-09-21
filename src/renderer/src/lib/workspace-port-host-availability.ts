import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

/**
 * Host a per-host scan key points at. `unknown` is kept distinct from `local` so
 * an unrecognised key (a synthetic projection key that leaked into the per-host
 * map, say) is never mislabelled as a local failure.
 */
export type WorkspacePortHostRef =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string }
  | { kind: 'unknown' }

export type UnavailableWorkspacePortHost = {
  scanKey: string
  host: WorkspacePortHostRef
  /** Platform the failed scan last ran on; drives the local host's label. */
  platform: NodeJS.Platform | null
  reason: string
}

// Why: mirrors workspacePortScanKeyForTarget (`${targetKey}:all`, where the
// target key is `local` or `environment:<id>`) without importing the heavier
// workspace-port-actions module into this pure helper. Splitting on the last
// `:all` keeps environment ids that themselves contain colons intact.
const ENVIRONMENT_SCAN_KEY_PREFIX = 'environment:'
const SCAN_KEY_SUFFIX = ':all'
const LOCAL_SCAN_KEY = `local${SCAN_KEY_SUFFIX}`

/** Host a per-host scan key names; `unknown` for any other key shape. */
export function workspacePortHostForScanKey(scanKey: string): WorkspacePortHostRef {
  if (scanKey === LOCAL_SCAN_KEY) {
    return { kind: 'local' }
  }
  if (!scanKey.endsWith(SCAN_KEY_SUFFIX) || !scanKey.startsWith(ENVIRONMENT_SCAN_KEY_PREFIX)) {
    return { kind: 'unknown' }
  }
  const environmentId = scanKey.slice(
    ENVIRONMENT_SCAN_KEY_PREFIX.length,
    scanKey.length - SCAN_KEY_SUFFIX.length
  )
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'unknown' }
}

/**
 * Every host whose latest scan failed, named by host rather than by scan key.
 * Why: on a remote host "none listening" and "could not look" are different
 * answers, and the merged projection collapses both the partial case (no reason
 * at all) and the total case (reasons joined with raw internal keys).
 */
export function getUnavailableWorkspacePortHosts(
  scansByKey: Record<string, WorkspacePortScanResult>
): UnavailableWorkspacePortHost[] {
  return Object.entries(scansByKey).flatMap(([scanKey, scan]) =>
    scan?.unavailableReason
      ? [
          {
            scanKey,
            host: workspacePortHostForScanKey(scanKey),
            platform: scan.platform === 'unknown' ? null : scan.platform,
            reason: scan.unavailableReason
          }
        ]
      : []
  )
}
