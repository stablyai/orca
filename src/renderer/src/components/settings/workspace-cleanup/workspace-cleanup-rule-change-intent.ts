import {
  resolveWorkspaceCleanupPolicy,
  hasEnabledWorkspaceCleanupRule,
  withEveryRuleOff,
  WORKSPACE_CLEANUP_RULE_KEYS,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type {
  WorkspaceCleanupPolicyRead,
  WorkspaceCleanupPolicyChange
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { WorkspaceCleanupRuleKey } from './workspace-cleanup-rule-keys'

export type CleanupChangeIntent = {
  setting: WorkspaceCleanupRuleKey | 'keepIgnoredFiles' | 'mode'
  kind: 'enable' | 'change' | 'inherit' | 'disable-ignored-files'
  changeRules?: (rules: WorkspaceCleanupRules) => WorkspaceCleanupRules
  mode?: 'global' | 'off' | 'custom'
}

export function proposedCleanupPolicy(
  read: WorkspaceCleanupPolicyRead,
  intent: CleanupChangeIntent
): WorkspaceCleanupPolicyChange {
  const { state } = structuredClone(read)
  if (!state.repoId) {
    return { scope: 'global', rules: intent.changeRules!(state.rules) }
  }
  const policy = state.projects[0].policy
  if (intent.mode === 'off') {
    return { scope: 'project', repoId: state.repoId, policy: { mode: 'off' } }
  }
  if (intent.mode === 'global') {
    return { scope: 'project', repoId: state.repoId, policy: null }
  }
  const base = resolveWorkspaceCleanupPolicy(
    { workspaceCleanupPolicy: state.rules },
    { workspaceCleanupPolicy: policy ?? undefined }
  ).rules
  const rules = intent.changeRules
    ? intent.changeRules(base)
    : policy?.mode === 'off'
      ? withEveryRuleOff(base)
      : base
  return { scope: 'project', repoId: state.repoId, policy: { mode: 'custom', rules } }
}

export function cleanupPolicyOnlyKeepsMore(
  read: WorkspaceCleanupPolicyRead,
  next: WorkspaceCleanupPolicyChange
): boolean {
  const policy = read.state.projects[0]?.policy
  const before = read.state.repoId
    ? resolveWorkspaceCleanupPolicy(
        { workspaceCleanupPolicy: read.state.rules },
        { workspaceCleanupPolicy: policy ?? undefined }
      ).rules
    : read.state.rules
  const after =
    next.scope === 'global'
      ? next.rules
      : resolveWorkspaceCleanupPolicy(
          { workspaceCleanupPolicy: read.state.rules },
          { workspaceCleanupPolicy: next.policy ?? undefined }
        ).rules
  if (after.keepWhen === 'uncommitted' && before.keepWhen === 'any-local-files') {
    return false
  }
  for (const key of WORKSPACE_CLEANUP_RULE_KEYS) {
    if (after[key].enabled && !before[key].enabled) {
      return false
    }
  }
  if (after.unchanged.enabled && after.unchanged.afterDays < before.unchanged.afterDays) {
    return false
  }
  if (
    after.inactive.enabled &&
    (after.inactive.afterDays < before.inactive.afterDays ||
      (after.inactive.action === 'delete' && before.inactive.action !== 'delete'))
  ) {
    return false
  }
  return true
}

export function cleanupPolicyHasEnabledRules(
  read: WorkspaceCleanupPolicyRead,
  next: WorkspaceCleanupPolicyChange
): boolean {
  if (next.scope === 'project') {
    return hasEnabledWorkspaceCleanupRule(
      resolveWorkspaceCleanupPolicy(
        { workspaceCleanupPolicy: read.state.rules },
        { workspaceCleanupPolicy: next.policy ?? undefined }
      ).rules
    )
  }
  return (
    hasEnabledWorkspaceCleanupRule(next.rules) ||
    read.state.projects.some((project) =>
      hasEnabledWorkspaceCleanupRule(
        resolveWorkspaceCleanupPolicy(
          { workspaceCleanupPolicy: next.rules },
          { workspaceCleanupPolicy: project.policy ?? undefined }
        ).rules
      )
    )
  )
}
