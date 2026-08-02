export const ORCHESTRATION_REPORT_TASK_LIMIT = 500
export const ORCHESTRATION_REPORT_DISPATCH_LIMIT = 2_000
export const ORCHESTRATION_REPORT_SESSION_LIMIT = 2_000

export type OrchestrationReportProvider = 'codex' | 'claude' | 'opencode'
export type OrchestrationReportWorktreeHostScope = 'local' | 'remote' | 'unknown'

export type OrchestrationReportWorktreeHost = {
  worktreeId: string
  scope: OrchestrationReportWorktreeHostScope
}

export type OrchestrationReportMetrics = {
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
  reasoningOutputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number
  estimatedCostUsd: number | null
  costStatus: 'known' | 'partial' | 'unavailable'
}

export type OrchestrationReportUsageSession = {
  provider: OrchestrationReportProvider
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  worktreeId: string | null
  locationStatus: 'exact' | 'mixed' | 'unavailable'
  model: string | null
  metrics: OrchestrationReportMetrics
}

export type OrchestrationReportUsageSnapshot = {
  provider: OrchestrationReportProvider
  status: 'available' | 'disabled' | 'error' | 'uninitialized' | 'stale' | 'scanning'
  lastScanCompletedAt: number | null
  message: string | null
  limitations: string[]
  sessions: OrchestrationReportUsageSession[]
  truncated: boolean
}

export type OrchestrationReportElapsed = {
  milliseconds: number | null
  status: 'available' | 'partial' | 'unavailable'
}

export type OrchestrationReportProviderUsage = {
  provider: OrchestrationReportProvider
  sessionCount: number
  metrics: OrchestrationReportMetrics
}

export type OrchestrationReportUsage = {
  attributionCertainty: 'inferred' | 'unavailable'
  providers: OrchestrationReportProviderUsage[]
}

export type OrchestrationReportDispatch = {
  id: string
  taskId: string
  status: string
  workerState: string | null
  createdAt: string
  dispatchedAt: string | null
  completedAt: string | null
  elapsed: OrchestrationReportElapsed
  identities: {
    assigneeTerminalHandle: string | null
    agentTerminalHandle: string | null
    terminalSessionId: null
    terminalSessionIdStatus: 'unavailable'
    worktreeId: string | null
    hostScope: OrchestrationReportWorktreeHostScope
    workdir: string | null
    workdirStatus: 'recorded' | 'unavailable'
    environmentId: string | null
    environmentName: string | null
  }
}

export type OrchestrationReportTask = {
  id: string
  parentId: string | null
  childIds: string[]
  status: string
  createdAt: string
  completedAt: string | null
  dispatches: OrchestrationReportDispatch[]
  elapsed: {
    direct: OrchestrationReportElapsed
    rolledUp: OrchestrationReportElapsed
  }
  usage: {
    direct: OrchestrationReportUsage
    rolledUp: OrchestrationReportUsage
  }
}

export type OrchestrationCostReport = {
  schemaVersion: 1
  generatedAt: string
  run: { id: string; createdAt: string; updatedAt: string }
  graph: { rootTaskIds: string[]; tasks: OrchestrationReportTask[] }
  totals: {
    elapsed: OrchestrationReportElapsed
    usage: OrchestrationReportUsage
  }
  attribution: {
    rule: 'exact_worktree_and_contained_dispatch_interval_unique_within_run'
    certainty: 'inferred_no_durable_terminal_provider_session_link'
    attributed: {
      provider: OrchestrationReportProvider
      sessionId: string
      dispatchId: string
      certainty: 'inferred'
    }[]
    unlinked: { provider: OrchestrationReportProvider; sessionId: string; reason: string }[]
    ambiguous: {
      provider: OrchestrationReportProvider
      sessionId: string
      eligibleDispatchIds: string[]
    }[]
  }
  provenance: {
    orchestration: 'live_runtime_database_structured_rows'
    usage: 'live_runtime_in_memory_usage_snapshots'
    usageHostScope: 'runtime_host_local_only'
    attribution: 'inferred_no_durable_terminal_provider_session_link'
    excluded: string[]
  }
  completeness: {
    status: 'complete' | 'partial'
    taskRows: { included: number; available: number; limit: number }
    dispatchRows: { included: number; available: number; limit: number }
    providerSessions: {
      provider: OrchestrationReportProvider
      scope: 'runtime_host_local_only'
      completeness: 'complete' | 'partial' | 'unavailable'
      included: number
      limit: number
      truncated: boolean
      status: 'available' | 'disabled' | 'error' | 'uninitialized' | 'stale' | 'scanning'
      lastScanCompletedAt: number | null
      message: string | null
      limitations: string[]
    }[]
    warnings: string[]
  }
}
