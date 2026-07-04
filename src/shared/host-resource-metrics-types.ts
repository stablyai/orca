// Resource metrics for an SSH execution host. Collected by the relay, which runs
// ON the remote machine, so these describe the remote box — not the local Orca
// process (that is covered by MemorySnapshot / HostMemory in ./types).

export type HostResourceMetrics = {
  totalMemory: number
  freeMemory: number
  usedMemory: number
  memoryUsagePercent: number
  cpuCoreCount: number
  /** 1/5/15-minute load averages. On Windows os.loadavg() is [0,0,0]. */
  loadAverage1m: number
  loadAverage5m: number
  loadAverage15m: number
  uptimeSeconds: number
  platform: NodeJS.Platform
}

export type HostMetricsResult = {
  metrics: HostResourceMetrics | null
}
