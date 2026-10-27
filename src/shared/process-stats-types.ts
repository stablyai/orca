export type StatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  // Sourced from aggregates, not the event log, so it survives event trimming.
  firstEventAt: number | null // timestamp of first-ever event, for "tracking since..."
}

/** cpu is percent of a single core — can exceed 100 on multi-core. memory is in bytes. */
export type UsageValues = {
  cpu: number
  memory: number
  /** Separate committed bytes, never a replacement for memory; absent means unknown, not zero. */
  privateMemory?: number
}

/** `footprint` is macOS phys_footprint (Activity Monitor's Memory): private pages plus GPU memory, shared pages excluded. */
export type ProcessMemoryMetric = 'rss' | 'working-set' | 'footprint'

/** Windows private commit charge (PageFileUsage/Private Bytes) includes paged-out memory, unlike working set.
 * It can reveal paging pressure even as resident memory shrinks. Unix snapshots omit this metric. */
export type ProcessCommitMetric = 'private-bytes'

export type HostAvailableMemorySource = 'memory-pressure' | 'proc-meminfo' | 'free-memory'

/** The top-level cpu/memory are the sum of main + renderer + other. */
export type AppMemory = UsageValues & {
  main: UsageValues
  renderer: UsageValues
  other: UsageValues
  /** Oldest-first memory samples (bytes) for the whole Orca app; empty before the first snapshot. */
  history: number[]
}

export type SessionMemory = UsageValues & {
  sessionId: string
  paneKey: string | null
  pid: number
}

/** The top-level cpu/memory are the sum of sessions. */
export type WorktreeMemory = UsageValues & {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  sessions: SessionMemory[]
  /** Oldest-first memory samples (bytes) for this worktree's tracked subtrees. */
  history: number[]
}

export type HostMemory = {
  totalMemory: number
  /** Immediately free memory reported by Node's host API. */
  freeMemory: number
  /** Memory available without material pressure, or freeMemory when unavailable. */
  availableMemory: number
  availableMemorySource: HostAvailableMemorySource
  /** totalMemory - availableMemory. */
  usedMemory: number
  memoryUsagePercent: number
  cpuCoreCount: number
  loadAverage1m: number
}

export type MemorySnapshot = {
  app: AppMemory
  worktrees: WorktreeMemory[]
  host: HostMemory
  /** Per-process byte metric used by app, session, worktree, history, and totalMemory values. */
  processMemoryMetric: ProcessMemoryMetric
  /** Committed-byte metric; absent on older hosts or unsupported captures means unknown, never zero. */
  processCommitMetric?: ProcessCommitMetric
  /** Sum of app + all tracked worktree sessions. Percent of a single core, so may exceed 100 on multi-core machines. */
  totalCpu: number
  /** Sum of per-process samples. With rss/working-set, shared pages may repeat, so this can exceed host.totalMemory. */
  totalMemory: number
  /** App plus tracked-worktree committed bytes, present exactly with processCommitMetric; exceeding physical RAM is meaningful. */
  totalPrivateMemory?: number
  collectedAt: number
}
