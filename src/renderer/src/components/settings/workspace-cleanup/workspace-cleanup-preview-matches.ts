import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupPreviewRow
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { WORKSPACE_CLEANUP_RULE_KEYS } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupRuleMatches } from './workspace-cleanup-rule-rows'
import {
  WORKSPACE_CLEANUP_RULE_REASON,
  type WorkspaceCleanupRuleKey
} from './workspace-cleanup-rule-keys'
import { workspaceCleanupRowKey } from './workspace-cleanup-workspace-line'

function removalsFor(
  preview: WorkspaceCleanupPreview,
  key: WorkspaceCleanupRuleKey
): WorkspaceCleanupPreviewRow[] {
  const reason = WORKSPACE_CLEANUP_RULE_REASON[key]
  return preview.rows.filter(
    (row) => row.evaluation.action !== 'keep' && row.evaluation.reason === reason
  )
}

/** Workspaces `next` would remove now that `current` would not. */
export function newRemovals(
  next: WorkspaceCleanupPreview,
  current: WorkspaceCleanupPreview | null
): WorkspaceCleanupPreviewRow[] {
  const removedNow = new Set(
    (current?.rows ?? [])
      .filter((row) => row.evaluation.action !== 'keep')
      .map(workspaceCleanupRowKey)
  )
  return next.rows.filter(
    (row) => row.evaluation.action !== 'keep' && !removedNow.has(workspaceCleanupRowKey(row))
  )
}

export function summarizeMatches(
  preview: WorkspaceCleanupPreview | null
): Partial<Record<WorkspaceCleanupRuleKey, WorkspaceCleanupRuleMatches>> | undefined {
  if (!preview) {
    return undefined
  }
  const matches: Partial<Record<WorkspaceCleanupRuleKey, WorkspaceCleanupRuleMatches>> = {}
  for (const key of WORKSPACE_CLEANUP_RULE_KEYS) {
    const rows = removalsFor(preview, key)
    matches[key] = { rows, sizeBytes: rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0) }
  }
  return matches
}
