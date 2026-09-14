import { track } from '@/lib/telemetry'
import {
  buildNestedRepoImportActionTelemetry,
  type NestedRepoTelemetryRuntimeKind
} from '../../../../shared/nested-repo-telemetry'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'

export function trackNestedFolderOpen(args: {
  attemptId: string | null
  runtimeKind: NestedRepoTelemetryRuntimeKind | null
  connectionId: string | null
  scan: NestedRepoScanResult
  selectedCount: number
  getRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
}): void {
  if (!args.attemptId) {
    return
  }
  track(
    'add_repo_nested_import_action',
    buildNestedRepoImportActionTelemetry({
      attemptId: args.attemptId,
      surface: 'sidebar',
      runtimeKind: args.runtimeKind ?? args.getRuntimeKind(args.connectionId),
      action: 'open_as_folder',
      foundCount: args.scan.repos.length,
      selectedCount: args.selectedCount
    })
  )
}
