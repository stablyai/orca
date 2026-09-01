import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { PersistedAgentLaunchFailure } from '../../../../shared/agent-launch-contract'

export type AutomationRunViewAvailability = 'terminal' | 'workspace' | 'snapshot' | 'metadata'

/** A run's structured unattended launch failure, surfaced for the recovery card.
 *  `forgottenAt` is set once an owner forgets a run stranded in
 *  `dispatching + launch_state_unknown`; the run then never retries. */
export type AutomationRunLaunchFailure = {
  failure: PersistedAgentLaunchFailure
  forgottenAt: number | null
}

/** Derive the run's launch-failure display data. Absent for non-launch dispatch
 *  failures (those keep only the generic `error` string). */
export function getAutomationRunLaunchFailure(run: AutomationRun): AutomationRunLaunchFailure | null {
  if (!run.agentLaunchFailure) {
    return null
  }
  return { failure: run.agentLaunchFailure, forgottenAt: run.agentLaunchForgottenAt ?? null }
}

export type AutomationRunViewState = {
  availability: AutomationRunViewAvailability
  actionLabel: string
  statusLabel: string
  canOpen: boolean
}

export const AUTOMATION_RERUN_PENDING_MIN_VISIBLE_MS = 800

export function getAutomationRerunPendingRemainingMs({
  pendingStartedAt,
  now = Date.now()
}: {
  pendingStartedAt: number
  now?: number
}): number {
  return Math.max(0, pendingStartedAt + AUTOMATION_RERUN_PENDING_MIN_VISIBLE_MS - now)
}

export async function waitForAutomationRerunPendingVisibility(
  pendingStartedAt: number
): Promise<void> {
  const remainingMs = getAutomationRerunPendingRemainingMs({ pendingStartedAt })
  if (remainingMs <= 0) {
    return
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs))
}

export function canRerunAutomationRun({
  automation,
  run
}: {
  automation: Automation | null
  run: AutomationRun
}): boolean {
  if (!automation || run.automationId !== automation.id) {
    return false
  }
  return (
    run.status === 'dispatch_failed' ||
    run.status === 'skipped_unavailable' ||
    run.status === 'skipped_needs_interactive_auth'
  )
}

export function getAutomationRunViewState({
  run,
  workspaceExists,
  terminalTargetExists
}: {
  run: AutomationRun
  workspaceExists: boolean
  terminalTargetExists: boolean
}): AutomationRunViewState {
  const hasTerminalIdentity = Boolean(run.terminalPaneKey && run.terminalPtyId)
  if (run.workspaceId && workspaceExists && terminalTargetExists) {
    return {
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run is open',
      canOpen: true
    }
  }

  if (run.workspaceId && workspaceExists && hasTerminalIdentity) {
    return {
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run terminal is unavailable.',
      canOpen: true
    }
  }

  if (run.workspaceId && workspaceExists) {
    return {
      availability: 'workspace',
      actionLabel: 'Resume workspace',
      statusLabel: 'Workspace is available.',
      canOpen: true
    }
  }

  if (run.outputSnapshot?.content.trim()) {
    return {
      availability: 'snapshot',
      actionLabel: 'Snapshot saved',
      statusLabel: 'Showing saved run snapshot.',
      canOpen: false
    }
  }

  return {
    availability: 'metadata',
    actionLabel: 'View run',
    statusLabel: run.workspaceId
      ? run.workspaceDisplayName?.trim()
        ? `${run.workspaceDisplayName.trim()} no longer available`
        : 'Workspace no longer available'
      : 'No workspace launched',
    canOpen: false
  }
}
