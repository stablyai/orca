import type { NestedRepoScanResult, Repo } from '../../../../shared/types'
import type { NestedRepoTelemetryRuntimeKind } from '../../../../shared/nested-repo-telemetry'

export type ShowNestedRepoReview = (args: {
  scan: NestedRepoScanResult
  selectedPath: string
  connectionId: string | null
  attemptId: string
  runtimeKind: NestedRepoTelemetryRuntimeKind
  inProgress: boolean
  scanId: string | null
  runtimeEnvironmentId?: string | null
}) => void

export type LocalPathAddResult =
  | { status: 'completed'; repo: Repo }
  | { status: 'cancelled' | 'paused' | 'skipped' }

export type LocalPathAddMode = 'single' | 'batch'
