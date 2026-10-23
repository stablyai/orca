import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import {
  publishWorkspacePortScanForHost,
  scanWorkspacePortsForTarget,
  workspacePortScanKeyForTarget,
  type WorkspacePortScanPublisher
} from './workspace-port-actions'

/** Re-scans one host now. A failed scan keeps the host's last-good ports and records the failure. */
export async function refreshWorkspacePortScanForTarget(
  args: WorkspacePortScanPublisher & { runtimeTarget: RuntimeClientTarget }
): Promise<void> {
  const scanKey = workspacePortScanKeyForTarget(args.runtimeTarget)
  const publish = (scan: WorkspacePortScanResult): void => {
    publishWorkspacePortScanForHost({ ...args, scanKey, scan })
  }
  try {
    publish(await scanWorkspacePortsForTarget(args.runtimeTarget))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Why: one dropped scan must not clear the host's last-good ports the way the background
    // poll's debounce does not; the failure is still recorded so the host is named as unavailable.
    const previous = args.getWorkspacePortScansByKey()[scanKey]
    publish({
      platform: previous?.platform ?? 'unknown',
      scannedAt: Date.now(),
      ports: previous?.ports ?? [],
      unavailableReason: message || 'Workspace port scan failed.'
    })
  }
}
