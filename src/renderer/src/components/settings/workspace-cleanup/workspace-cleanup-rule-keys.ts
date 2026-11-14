import {
  WORKSPACE_ARCHIVE_SUPPORTED,
  type WORKSPACE_CLEANUP_RULE_KEYS,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupRuleReason } from '../../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'

export type WorkspaceCleanupRuleKey = (typeof WORKSPACE_CLEANUP_RULE_KEYS)[number]

export const WORKSPACE_CLEANUP_RULE_REASON: Record<
  WorkspaceCleanupRuleKey,
  WorkspaceCleanupRuleReason
> = {
  merged: 'merged',
  unchanged: 'unchanged',
  inactive: 'inactive',
  automationRuns: 'automation-run',
  orchestrationWorkers: 'orchestration-worker'
}

/** Turns one rule on or off; turning the inactive rule on picks delete while Orca cannot archive. */
export function setWorkspaceCleanupRuleEnabled(
  rules: WorkspaceCleanupRules,
  key: WorkspaceCleanupRuleKey,
  enabled: boolean
): WorkspaceCleanupRules {
  if (key === 'inactive') {
    return {
      ...rules,
      inactive: {
        ...rules.inactive,
        enabled,
        ...(enabled && !WORKSPACE_ARCHIVE_SUPPORTED ? { action: 'delete' as const } : {})
      }
    }
  }
  return { ...rules, [key]: { ...rules[key], enabled } }
}
