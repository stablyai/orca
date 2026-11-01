import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

/** Distinguish unknown scan keys from local so leaked projection keys cannot become local-host failures. */
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

// Match targetKey:all without heavy actions imports; split at the final :all because environment IDs can contain colons.
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

/** Name failed hosts explicitly: merged scans obscure partial failures and join total failures with raw keys, while could-not-look differs from no-listeners. */
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
