import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'

type BroadScanEntry = {
  scanId: string
  promise: Promise<WorkspaceCleanupScanResult>
}

const inFlightScans = new Map<string, BroadScanEntry>()
const supersededScanIds = new Set<string>()

export class WorkspaceCleanupScanSupersededError extends Error {
  constructor() {
    super('Workspace cleanup scan superseded')
    this.name = 'WorkspaceCleanupScanSupersededError'
  }
}

export function isWorkspaceCleanupScanSupersededError(
  error: unknown
): error is WorkspaceCleanupScanSupersededError {
  return error instanceof WorkspaceCleanupScanSupersededError
}

export function getInFlightWorkspaceCleanupScan(
  key: string
): Promise<WorkspaceCleanupScanResult> | undefined {
  return inFlightScans.get(key)?.promise
}

export function hasInFlightWorkspaceCleanupScan(key: string): boolean {
  return inFlightScans.has(key)
}

export function registerInFlightWorkspaceCleanupScan(
  key: string,
  scanId: string,
  promise: Promise<WorkspaceCleanupScanResult>
): void {
  inFlightScans.set(key, { scanId, promise })
}

export function releaseInFlightWorkspaceCleanupScan(
  key: string,
  scanId: string,
  promise: Promise<WorkspaceCleanupScanResult>
): void {
  if (inFlightScans.get(key)?.promise === promise) {
    inFlightScans.delete(key)
  }
  supersededScanIds.delete(scanId)
}

// Why: a scan whose promise never settles (renderer teardown mid-scan) would
// otherwise leave its id here for the process lifetime.
const MAX_SUPERSEDED_SCAN_IDS = 64

export function supersedeInFlightWorkspaceCleanupScans(
  cancelScan: ((scanId: string) => Promise<boolean>) | undefined,
  shouldSupersede: (key: string) => boolean = () => true
): void {
  for (const [key, { scanId }] of inFlightScans) {
    if (!shouldSupersede(key)) {
      continue
    }
    supersededScanIds.add(scanId)
    inFlightScans.delete(key)
    void cancelScan?.(scanId).catch((error: unknown) => {
      console.warn('Failed to cancel superseded workspace cleanup scan:', error)
    })
  }
  for (const scanId of supersededScanIds) {
    if (supersededScanIds.size <= MAX_SUPERSEDED_SCAN_IDS) {
      break
    }
    supersededScanIds.delete(scanId)
  }
}

export function throwIfWorkspaceCleanupScanSuperseded(scanId: string): void {
  if (supersededScanIds.has(scanId)) {
    throw new WorkspaceCleanupScanSupersededError()
  }
}

export function normalizeWorkspaceCleanupScanError(scanId: string, error: unknown): unknown {
  return supersededScanIds.has(scanId) ? new WorkspaceCleanupScanSupersededError() : error
}
