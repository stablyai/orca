// Pure view-model for the capacity-recovery sheet: turns a host-redacted
// PendingAgentLaunchSummaryRow into a display shape + the one action a client
// may take on it. Store/IPC-free so it unit-tests without a renderer; the sheet
// component translates the label ids and dispatches the resolved action.

import type {
  PendingAgentLaunchSummaryRow,
  PendingAgentLaunchLiveness
} from '../../../shared/agent-launch-pending-summary'
import type { AgentLaunchIntentKind } from '../../../shared/agent-launch-contract'

/** The single action a client may take on a pending-launch row. A run owner
 *  deep-links to its owning automation run; every other routable owner
 *  (worktree, plus task/session once their worktree scope resolves) reveals its
 *  owning worktree — the sheet lands on that surface's recovery card. An owner
 *  whose worktree scope hasn't resolved yet resolves to `null` (copy-only row). */
export type CapacityRecoveryRowAction =
  | { kind: 'open-worktree'; worktreeId: string }
  | { kind: 'open-automation-run'; automationId: string; runId: string }

export type CapacityRecoveryRowView = {
  sourceKind: AgentLaunchIntentKind
  hostDisplayName: string
  admittedAt: number
  liveness: PendingAgentLaunchLiveness
  action: CapacityRecoveryRowAction | null
}

/** Resolve the routable action for a row. A worktree deep link opens the owning
 *  workspace (live rows reveal the terminal; absent/unknown rows land on its
 *  recovery card). A run opens its owning automation run. Task and session
 *  owners route to their owning worktree by the same principle — a dedicated
 *  task surface is deferred to U9 — but only once the host has resolved the
 *  worktree scope; until then the row is copy-only (`null`). */
export function resolveCapacityRowAction(
  row: PendingAgentLaunchSummaryRow
): CapacityRecoveryRowAction | null {
  const link = row.deepLink
  if (!link) {
    return null
  }
  switch (link.kind) {
    case 'worktree':
      return { kind: 'open-worktree', worktreeId: link.worktreeId }
    case 'run':
      return { kind: 'open-automation-run', automationId: link.automationId, runId: link.runId }
    case 'task':
    case 'session':
      return link.worktreeId ? { kind: 'open-worktree', worktreeId: link.worktreeId } : null
  }
}

/** i18n key + English fallback for a row's action button, keyed off the routed
 *  destination (an automation run reads "Go to run"; a worktree reads "Open"
 *  when its terminal is live, else "Go to workspace"). */
export function capacityActionCopy(
  action: CapacityRecoveryRowAction,
  liveness: PendingAgentLaunchLiveness
): { key: string; fallback: string } {
  if (action.kind === 'open-automation-run') {
    return { key: 'agentLaunch.capacity.action.goToRun', fallback: 'Go to run' }
  }
  return liveness === 'live'
    ? { key: 'agentLaunch.capacity.action.open', fallback: 'Open' }
    : { key: 'agentLaunch.capacity.action.goToWorkspace', fallback: 'Go to workspace' }
}

export function toCapacityRecoveryRowView(
  row: PendingAgentLaunchSummaryRow
): CapacityRecoveryRowView {
  return {
    sourceKind: row.sourceKind,
    hostDisplayName: row.targetHostDisplayName,
    admittedAt: row.admittedAt,
    liveness: row.liveness,
    action: resolveCapacityRowAction(row)
  }
}

/** i18n key + English fallback for a launch's source kind. */
export function sourceKindCopy(kind: AgentLaunchIntentKind): { key: string; fallback: string } {
  switch (kind) {
    case 'interactive':
      return { key: 'agentLaunch.capacity.source.interactive', fallback: 'Workspace' }
    case 'cli':
      return { key: 'agentLaunch.capacity.source.cli', fallback: 'CLI' }
    case 'automation':
      return { key: 'agentLaunch.capacity.source.automation', fallback: 'Automation' }
    case 'background':
      return { key: 'agentLaunch.capacity.source.background', fallback: 'Background' }
    case 'orchestration':
      return { key: 'agentLaunch.capacity.source.orchestration', fallback: 'Orchestration' }
    case 'resume':
      return { key: 'agentLaunch.capacity.source.resume', fallback: 'Resume' }
  }
}

/** i18n key + English fallback for a row's liveness badge. */
export function livenessCopy(liveness: PendingAgentLaunchLiveness): {
  key: string
  fallback: string
} {
  switch (liveness) {
    case 'live':
      return { key: 'agentLaunch.capacity.liveness.live', fallback: 'Running' }
    case 'absent':
      return { key: 'agentLaunch.capacity.liveness.absent', fallback: 'Not running' }
    case 'unknown':
      return { key: 'agentLaunch.capacity.liveness.unknown', fallback: 'Unreachable' }
  }
}
