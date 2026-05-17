import type { AutomationRun } from '../../../../shared/automations-types'

export type AutomationRunViewAvailability = 'terminal' | 'workspace' | 'snapshot' | 'metadata'

export type AutomationRunViewState = {
  availability: AutomationRunViewAvailability
  actionLabel: string
  statusLabel: string
  canOpen: boolean
}

export function getAutomationRunViewState({
  run,
  workspaceExists,
  terminalTabExists
}: {
  run: AutomationRun
  workspaceExists: boolean
  terminalTabExists: boolean
}): AutomationRunViewState {
  if (run.workspaceId && workspaceExists && run.terminalSessionId && terminalTabExists) {
    return {
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run is open',
      canOpen: true
    }
  }

  if (run.workspaceId && workspaceExists) {
    return {
      availability: 'workspace',
      actionLabel: 'Open workspace',
      statusLabel: run.terminalSessionId
        ? 'Opened workspace; original terminal is closed.'
        : 'Opened workspace.',
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
