import type {
  WorkspaceCleanupKeepCause,
  WorkspaceCleanupRuleReason,
  WorkspaceCleanupWaiting
} from './workspace-cleanup-evaluation'

/** Plain-words names for the rule that matched a workspace. */
export const WORKSPACE_CLEANUP_RULE_REASON_LABELS: Record<WorkspaceCleanupRuleReason, string> = {
  merged: 'merged',
  unchanged: 'no changes',
  inactive: 'inactive'
}

/** Plain-words names for why the runner left a workspace alone. */
export const WORKSPACE_CLEANUP_KEEP_CAUSE_LABELS: Record<WorkspaceCleanupKeepCause, string> = {
  'not-removable': 'main workspace or folder project',
  'project-off': 'cleanup off for this project',
  'rules-off': 'no rule on',
  pinned: 'pinned',
  'no-rule-matched': 'no rule matched',
  waiting: 'waiting',
  'recently-active': 'used in the last hour',
  'active-workspace': 'active workspace',
  'agent-running': 'agent running',
  'terminal-running': 'terminal running a process',
  'terminal-unknown': 'terminal state unknown',
  'unsaved-editor-changes': 'unsaved editor changes',
  'uncommitted-changes': 'uncommitted changes',
  'unpushed-commits': 'unpushed commits',
  'ignored-files': 'ignored local files',
  'git-unknown': 'Git status unknown',
  'archive-unavailable': 'archive not available',
  'archive-script': 'has an archive script',
  removing: 'already being removed'
}

// A newer host can send a value this build has no label for; show it raw rather than nothing.
export function formatWorkspaceCleanupRuleReason(reason: WorkspaceCleanupRuleReason): string {
  return WORKSPACE_CLEANUP_RULE_REASON_LABELS[reason] ?? reason
}

export function formatWorkspaceCleanupKeepCause(
  cause: WorkspaceCleanupKeepCause,
  waiting?: WorkspaceCleanupWaiting
): string {
  return cause === 'waiting' && waiting
    ? `waiting ${waiting.elapsedDays} of ${waiting.afterDays} days`
    : (WORKSPACE_CLEANUP_KEEP_CAUSE_LABELS[cause] ?? cause)
}
