export type ResourceUsageSpaceScanSnapshot = {
  ready: boolean
  previousScanning: boolean
  lastSeenScannedAt: number | null
}

export function resolveResourceUsageSpaceScanReady({
  snapshot,
  runtimeEnvironmentActive,
  open,
  activeView,
  scannedAt,
  scanning
}: {
  snapshot: ResourceUsageSpaceScanSnapshot
  runtimeEnvironmentActive: boolean
  open: boolean
  activeView: string
  scannedAt: number | null
  scanning: boolean
}): ResourceUsageSpaceScanSnapshot {
  if (runtimeEnvironmentActive) {
    return {
      ready: false,
      previousScanning: false,
      lastSeenScannedAt: snapshot.lastSeenScannedAt
    }
  }

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
