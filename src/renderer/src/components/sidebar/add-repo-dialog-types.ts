import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
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

export type AddRepoDialogStep = 'add' | 'clone' | 'remote' | 'server-path' | 'create' | 'nested'

export function defaultProjectGroupNameForPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/g, '')
      .split(/[\\/]/)
      .findLast(Boolean) ?? path
  )
}

export function createNestedRepoScanId(): string {
  return `nested-repo-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
