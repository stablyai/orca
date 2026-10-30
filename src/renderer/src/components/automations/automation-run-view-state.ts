import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'

export type AutomationRunViewAvailability = 'terminal' | 'workspace' | 'snapshot' | 'metadata'

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
  terminalTargetExists,
  terminalOnPairedServer = false
}: {
  run: AutomationRun
  workspaceExists: boolean
  terminalTargetExists: boolean
  /** The workspace's paired server holds the terminal; only it can say whether it still lives. */
  terminalOnPairedServer?: boolean
}): AutomationRunViewState {
  const hasTerminalIdentity = Boolean(run.terminalPaneKey && run.terminalPtyId)
  // Why the pane alone: a slept run drops its PTY id but keeps its pane, which the server resumes.
  const hasPaneIdentity = Boolean(run.terminalPaneKey)
  if (run.workspaceId && workspaceExists && terminalTargetExists) {
    return {
      availability: 'terminal',
      actionLabel: translate('auto.components.automations.runViewState.viewRun', 'View run'),
      statusLabel: translate('auto.components.automations.runViewState.runOpen', 'Run is open'),
      canOpen: true
    }
  }

  if (run.workspaceId && workspaceExists && hasPaneIdentity && terminalOnPairedServer) {
    return {
      availability: 'terminal',
      actionLabel: translate('auto.components.automations.runViewState.viewRun', 'View run'),
      statusLabel: translate(
        'auto.components.automations.runViewState.terminalOnPairedServer',
        'Run terminal is on the paired server.'
      ),
      canOpen: true
    }
  }

  if (run.workspaceId && workspaceExists && hasTerminalIdentity) {
    return {
      availability: 'terminal',
      actionLabel: translate('auto.components.automations.runViewState.viewRun', 'View run'),
      statusLabel: translate(
        'auto.components.automations.runViewState.terminalUnavailable',
        'Run terminal is unavailable.'
      ),
      canOpen: true
    }
  }

  // Why: a run that never dispatched left no agent to resume; opening seeds an empty shell (STA-10103).
  if (run.workspaceId && workspaceExists && run.dispatchedAt !== null) {
    return {
      availability: 'workspace',
      actionLabel: translate(
        'auto.components.automations.runViewState.openWorkspace',
        'Open workspace'
      ),
      statusLabel: translate(
        'auto.components.automations.runViewState.workspaceAvailable',
        'Workspace is available.'
      ),
      canOpen: true
    }
  }

  if (run.outputSnapshot?.content.trim()) {
    return {
      availability: 'snapshot',
      actionLabel: translate(
        'auto.components.automations.runViewState.snapshotSaved',
        'Snapshot saved'
      ),
      statusLabel: translate(
        'auto.components.automations.runViewState.showingSnapshot',
        'Showing saved run snapshot.'
      ),
      canOpen: false
    }
  }

  return {
    availability: 'metadata',
    actionLabel: translate('auto.components.automations.runViewState.viewRun', 'View run'),
    statusLabel: run.workspaceId
      ? run.workspaceDisplayName?.trim()
        ? translate(
            'auto.components.automations.runViewState.namedWorkspaceGone',
            '{{name}} no longer available',
            { name: run.workspaceDisplayName.trim() }
          )
        : translate(
            'auto.components.automations.runViewState.workspaceGone',
            'Workspace no longer available'
          )
      : translate(
          'auto.components.automations.runViewState.noWorkspaceLaunched',
          'No workspace launched'
        ),
    canOpen: false
  }
}
