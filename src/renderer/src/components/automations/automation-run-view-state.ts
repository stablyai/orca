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
      actionLabel: translate(
        'auto.components.automations.automation.run.view.state.54f28daf9c',
        'View run'
      ),
      statusLabel: translate(
        'auto.components.automations.automation.run.view.state.22522086c4',
        'Run is open'
      ),
      canOpen: true
    }
  }

  if (run.workspaceId && workspaceExists && hasTerminalIdentity) {
    return {
      availability: 'terminal',
      actionLabel: translate(
        'auto.components.automations.automation.run.view.state.54f28daf9c',
        'View run'
      ),
      statusLabel: translate(
        'auto.components.automations.automation.run.view.state.512cb6234a',
        'Run terminal is unavailable.'
      ),
      canOpen: true
    }
  }

  if (run.workspaceId && workspaceExists) {
    return {
      availability: 'workspace',
      actionLabel: translate(
        'auto.components.automations.automation.run.view.state.6ea3f7882d',
        'Resume workspace'
      ),
      statusLabel: translate(
        'auto.components.automations.automation.run.view.state.160f368f8e',
        'Workspace is available.'
      ),
      canOpen: true
    }
  }

  if (run.outputSnapshot?.content.trim()) {
    return {
      availability: 'snapshot',
      actionLabel: translate(
        'auto.components.automations.automation.run.view.state.358ae795ea',
        'Snapshot saved'
      ),
      statusLabel: translate(
        'auto.components.automations.automation.run.view.state.63a8bd42bd',
        'Showing saved run snapshot.'
      ),
      canOpen: false
    }
  }

  return {
    availability: 'metadata',
    actionLabel: translate(
      'auto.components.automations.automation.run.view.state.54f28daf9c',
      'View run'
    ),
    statusLabel: run.workspaceId
      ? run.workspaceDisplayName?.trim()
        ? translate(
            'auto.components.automations.automation.run.view.state.a4f3aa5960',
            '{{value0}} no longer available',
            { value0: run.workspaceDisplayName.trim() }
          )
        : translate(
            'auto.components.automations.automation.run.view.state.272939969f',
            'Workspace no longer available'
          )
      : translate(
          'auto.components.automations.automation.run.view.state.cbd6ff6dd8',
          'No workspace launched'
        ),
    canOpen: false
  }
}
