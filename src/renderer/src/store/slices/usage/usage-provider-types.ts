export type UsageFailure = {
  terminal: boolean
  read: boolean
  refresh: boolean
  setting: boolean
}

export type UsageSnapshot = {
  scanState: {
    enabled: boolean
    isScanning: boolean
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
  summary: object
  daily: object[]
  modelBreakdown: object[]
  projectBreakdown: object[]
  recentSessions: object[]
}

export type UsageProviderTypes<
  Scope extends string,
  Range extends string,
  Snapshot extends UsageSnapshot
> = {
  scope: Scope
  range: Range
  snapshot: Snapshot
}
