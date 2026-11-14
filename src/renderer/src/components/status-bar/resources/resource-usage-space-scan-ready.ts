export type ResourceUsageSpaceScanSnapshot = {
  ready: boolean
  previousScanning: boolean
  lastSeenScannedAt: number | null
}

export function resolveResourceUsageSpaceScanReady({
  snapshot,
  open,
  activeView,
  scannedAt,
  scanning
}: {
  snapshot: ResourceUsageSpaceScanSnapshot
  open: boolean
  activeView: string
  scannedAt: number | null
  scanning: boolean
}): ResourceUsageSpaceScanSnapshot {
  const scanCompleted =
    snapshot.previousScanning &&
    !scanning &&
    scannedAt !== null &&
    scannedAt !== snapshot.lastSeenScannedAt

  if (scanCompleted) {
    return {
      ready: !open && activeView !== 'space',
      previousScanning: scanning,
      lastSeenScannedAt: scannedAt
    }
  }

  if (snapshot.ready && (open || activeView === 'space')) {
    return {
      ready: false,
      previousScanning: scanning,
      lastSeenScannedAt: scannedAt
    }
  }

  if (snapshot.previousScanning !== scanning) {
    return {
      ...snapshot,
      previousScanning: scanning
    }
  }

  return snapshot
}
