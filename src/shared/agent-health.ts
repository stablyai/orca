export type AgentHealthProvider = 'claude' | 'codex'

export type AgentHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

export type AgentCliStatus = 'available' | 'unavailable'

export type AgentHealthCheckId = 'cli' | 'authentication' | 'provider' | 'websocket'

export type AgentHealthCheckStatus = 'ok' | 'warning' | 'failed'

export type AgentUpdateAvailability = 'available' | 'current' | 'unknown'

export type AgentUpdateOutcome = 'updated' | 'current'

export type AgentHealthCheck = {
  id: AgentHealthCheckId
  status: AgentHealthCheckStatus
}

export type AgentHealthSnapshot = {
  provider: AgentHealthProvider
  cliStatus: AgentCliStatus
  health: AgentHealthState
  version: string | null
  durationMs: number
  checkedAt: number
  checks: AgentHealthCheck[]
  latestVersion?: string | null
  updateAvailability?: AgentUpdateAvailability
  updateSupported?: boolean
}

export type AgentUpdateResult = {
  provider: AgentHealthProvider
  outcome: AgentUpdateOutcome
  previousVersion: string
  currentVersion: string
}
