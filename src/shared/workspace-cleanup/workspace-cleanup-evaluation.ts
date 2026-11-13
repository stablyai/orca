import type { WorkspaceCleanupBlocker, WorkspaceCleanupCandidate } from './workspace-cleanup'
import {
  hasEnabledWorkspaceCleanupRule,
  type ResolvedWorkspaceCleanupPolicy
} from './workspace-cleanup-policy'

const DAY_MS = 24 * 60 * 60 * 1000
// A workspace touched this recently may still be in use (a merged branch just checked out to read it).
export const WORKSPACE_CLEANUP_RULE_GRACE_MS = 60 * 60 * 1000

/** The rule that would remove a workspace. */
export type WorkspaceCleanupRuleReason =
  | 'merged'
  | 'unchanged'
  | 'inactive'
  | 'automation-run'
  | 'orchestration-worker'

/** Why the runner leaves a workspace alone; one cause per workspace, the first that applies. */
export type WorkspaceCleanupKeepCause =
  | 'not-removable'
  | 'project-off'
  | 'rules-off'
  | 'pinned'
  | 'no-rule-matched'
  | 'waiting'
  | 'recently-active'
  | 'active-workspace'
  | 'agent-running'
  | 'terminal-running'
  | 'terminal-unknown'
  | 'unsaved-editor-changes'
  | 'uncommitted-changes'
  | 'unpushed-commits'
  | 'ignored-files'
  | 'git-unknown'
  | 'archive-unavailable'
  | 'archive-script'
  | 'removing'

export type WorkspaceCleanupWaiting = { elapsedDays: number; afterDays: number }

export type WorkspaceCleanupEvaluation =
  | { action: 'delete' | 'archive'; reason: WorkspaceCleanupRuleReason }
  | {
      action: 'keep'
      cause: WorkspaceCleanupKeepCause
      /** The rule that matched, when a protection is what kept it. */
      reason?: WorkspaceCleanupRuleReason
      /** Set for 'waiting': the time rule closest to firing. */
      waiting?: WorkspaceCleanupWaiting
    }

export type WorkspaceCleanupEvaluationInput = Pick<
  WorkspaceCleanupCandidate,
  'reasons' | 'blockers' | 'lastActivityAt' | 'git'
>

const NOT_REMOVABLE_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> = new Set([
  'main-worktree',
  'folder-repo'
])

// Priority order: the first present blocker names the keep cause.
const PROTECTIONS: readonly [WorkspaceCleanupBlocker, WorkspaceCleanupKeepCause][] = [
  ['active-workspace', 'active-workspace'],
  ['live-agent', 'agent-running'],
  ['running-terminal', 'terminal-running'],
  ['terminal-liveness-unknown', 'terminal-unknown'],
  ['dirty-editor-buffer', 'unsaved-editor-changes'],
  ['dirty-files', 'uncommitted-changes'],
  ['unpushed-commits', 'unpushed-commits'],
  ['ignored-files', 'ignored-files'],
  ['unknown-base', 'git-unknown'],
  ['git-status-error', 'git-unknown'],
  ['ssh-disconnected', 'git-unknown']
]

type RuleMatch = { reason: WorkspaceCleanupRuleReason } | { waiting: WorkspaceCleanupWaiting }

function timeRuleMatch(
  reason: WorkspaceCleanupRuleReason,
  afterDays: number,
  elapsedMs: number
): RuleMatch {
  return elapsedMs >= afterDays * DAY_MS
    ? { reason }
    : { waiting: { elapsedDays: Math.floor(Math.max(0, elapsedMs) / DAY_MS), afterDays } }
}

function matchRules(
  input: WorkspaceCleanupEvaluationInput,
  policy: ResolvedWorkspaceCleanupPolicy,
  elapsedMs: number
): RuleMatch[] {
  const { rules } = policy
  const matches: RuleMatch[] = []
  if (rules.merged.enabled && input.reasons.includes('merged')) {
    matches.push({ reason: 'merged' })
  }
  if (rules.automationRuns.enabled && input.reasons.includes('automation-run')) {
    matches.push({ reason: 'automation-run' })
  }
  if (rules.orchestrationWorkers.enabled && input.reasons.includes('orchestration-worker')) {
    matches.push({ reason: 'orchestration-worker' })
  }
  if (rules.unchanged.enabled && input.reasons.includes('unchanged')) {
    matches.push(timeRuleMatch('unchanged', rules.unchanged.afterDays, elapsedMs))
  }
  if (rules.inactive.enabled) {
    matches.push(timeRuleMatch('inactive', rules.inactive.afterDays, elapsedMs))
  }
  return matches
}

function closestWaiting(matches: RuleMatch[]): WorkspaceCleanupWaiting | undefined {
  let closest: WorkspaceCleanupWaiting | undefined
  for (const match of matches) {
    if (
      'waiting' in match &&
      (!closest ||
        match.waiting.afterDays - match.waiting.elapsedDays <
          closest.afterDays - closest.elapsedDays)
    ) {
      closest = match.waiting
    }
  }
  return closest
}

function protectionCause(
  input: WorkspaceCleanupEvaluationInput,
  policy: ResolvedWorkspaceCleanupPolicy
): WorkspaceCleanupKeepCause | null {
  for (const [blocker, cause] of PROTECTIONS) {
    if (blocker === 'ignored-files' && policy.rules.keepWhen !== 'any-local-files') {
      continue
    }
    if (input.blockers.includes(blocker)) {
      return cause
    }
  }
  // Removal needs fresh proof that nothing is uncommitted; absent evidence is never clean.
  if (input.git.checkedAt === null || input.git.clean === null) {
    return 'git-unknown'
  }
  return input.git.clean ? null : 'uncommitted-changes'
}

/** The one decision every cleanup entry point shares: what the runner does with a workspace now. */
export function evaluateWorkspaceCleanup(
  input: WorkspaceCleanupEvaluationInput,
  policy: ResolvedWorkspaceCleanupPolicy,
  now: number
): WorkspaceCleanupEvaluation {
  if (input.blockers.some((blocker) => NOT_REMOVABLE_BLOCKERS.has(blocker))) {
    return { action: 'keep', cause: 'not-removable' }
  }
  if (policy.source === 'project-off') {
    return { action: 'keep', cause: 'project-off' }
  }
  if (!hasEnabledWorkspaceCleanupRule(policy.rules)) {
    return { action: 'keep', cause: 'rules-off' }
  }
  if (input.blockers.includes('pinned')) {
    return { action: 'keep', cause: 'pinned' }
  }
  const elapsedMs = now - input.lastActivityAt
  const matches = matchRules(input, policy, elapsedMs)
  const matched = matches.find(
    (match): match is { reason: WorkspaceCleanupRuleReason } => 'reason' in match
  )
  if (!matched) {
    const waiting = closestWaiting(matches)
    return waiting
      ? { action: 'keep', cause: 'waiting', waiting }
      : { action: 'keep', cause: 'no-rule-matched' }
  }
  const { reason } = matched
  if (elapsedMs < WORKSPACE_CLEANUP_RULE_GRACE_MS) {
    return { action: 'keep', cause: 'recently-active', reason }
  }
  const protection = protectionCause(input, policy)
  if (protection) {
    return { action: 'keep', cause: protection, reason }
  }
  if (reason !== 'inactive' || policy.rules.inactive.action === 'delete') {
    return { action: 'delete', reason }
  }
  return policy.inactiveActionSupported
    ? { action: 'archive', reason }
    : { action: 'keep', cause: 'archive-unavailable', reason }
}
