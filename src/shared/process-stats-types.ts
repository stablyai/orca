// ─── Stats ──────────────────────────────────────────────────────────

export type StatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  // Sourced from aggregates, not the event log, so it survives event trimming.
  firstEventAt: number | null // timestamp of first-ever event, for "tracking since..."
}

// ─── Memory dashboard ──────────────────────────────────────────────

/** cpu is percent of a single core — can exceed 100 on multi-core. memory is in bytes. */
export type UsageValues = {
  cpu: number
  memory: number
  /**
   * Committed bytes (see `ProcessCommitMetric`), a second quantity alongside
   * `memory` — never a substitute for it. Absent means the host cannot report
   * it; absent must never be read as zero.
   */
  privateMemory?: number
}

export type ProcessMemoryMetric = 'rss' | 'working-set'

/**
 * Unit of every `privateMemory` field in a snapshot.
 *
 * `private-bytes` is the Windows private commit charge
 * (`Win32_Process.PageFileUsage` / `\Process(*)\Private Bytes`): memory a
 * process has committed whether or not it is currently resident. Working set
 * counts only resident pages, so an agent whose pages have been trimmed to the
 * pagefile shrinks its working set while still holding the commit that pushes
 * the host into paging. Unix has no equivalent, so snapshots from those hosts
 * carry no commit metric at all.
 */
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
  /**
   * Names the unit of every `privateMemory` field below. Absent when this sweep
   * produced none — an older host, or any host whose process table cannot
   * report committed bytes. Readers must treat absence as unknown, not zero.
   */
  processCommitMetric?: ProcessCommitMetric
  /** Sum of app + all tracked worktree sessions. Percent of a single core, so may exceed 100 on multi-core machines. */
  totalCpu: number
  /** Sum of per-process samples. Shared pages may repeat, so this can exceed host.totalMemory. */
  totalMemory: number
  /**
   * Sum of app + all tracked worktree `privateMemory`. Present exactly when
   * `processCommitMetric` is. Committed bytes are not bounded by physical RAM,
   * so exceeding host.totalMemory is the signal, not a bug.
   */
  totalPrivateMemory?: number
  collectedAt: number
}
