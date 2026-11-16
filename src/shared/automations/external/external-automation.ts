export type ExternalAutomationProvider = 'openclaw'

export type ExternalAutomationManagerStatus = 'available' | 'unavailable'

export type ExternalAutomationAction = 'pause' | 'resume' | 'run' | 'delete'

export type ExternalAutomationRunStatus = 'completed' | 'failed' | 'unknown'

export type ExternalAutomationTarget =
  | {
      type: 'local'
    }
  | {
      type: 'ssh'
      connectionId: string
    }

export type ExternalAutomationJob = {
  id: string
  managerId: string
  provider: ExternalAutomationProvider
  name: string
  schedule: string
  rawSchedule: string | null
  enabled: boolean
  state: string
  prompt: string | null
  promptPreview: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  workdir: string | null
  runCount: number
  runCountSaturated?: true
  runs: ExternalAutomationRun[]
}

export type ExternalAutomationRun = {
  id: string
  managerId: string
  provider: ExternalAutomationProvider
  jobId: string
  runAt: string | null
  status: ExternalAutomationRunStatus
  outputPreview: string | null
  outputContent: string | null
  error: string | null
  outputPath: string | null
}

export type ExternalAutomationManager = {
  id: string
  provider: ExternalAutomationProvider
  label: string
  targetLabel: string
  target: ExternalAutomationTarget
  status: ExternalAutomationManagerStatus
  error: string | null
  canManage: boolean
  jobs: ExternalAutomationJob[]
}

export type ExternalAutomationActionInput = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  jobId: string
  action: ExternalAutomationAction
}
