import { translate } from '@/i18n/i18n'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/worktree/types'

export type AutomationRunWorkspaceDisplay = {
  rowLabel: string
  detailLabel: string
  muted: boolean
  title?: string
}

export function getAutomationRunWorkspaceDisplay({
  run,
  worktree
}: {
  run: AutomationRun
  worktree: Worktree | null
}): AutomationRunWorkspaceDisplay {
  if (!run.workspaceId) {
    return {
      rowLabel: translate(
        'auto.components.automations.runWorkspaceDisplay.notLaunched',
        'Not launched'
      ),
      detailLabel: translate(
        'auto.components.automations.runWorkspaceDisplay.notLaunched',
        'Not launched'
      ),
      muted: true
    }
  }
  if (worktree) {
    return {
      rowLabel: worktree.displayName,
      detailLabel: worktree.displayName,
      muted: false,
      title: worktree.displayName
    }
  }

  const previousName = run.workspaceDisplayName?.trim()
  if (previousName) {
    const deletedLabel = translate(
      'auto.components.automations.runWorkspaceDisplay.namedWorkspaceGone',
      '{{name}} (no longer available)',
      { name: previousName }
    )
    return {
      rowLabel: previousName,
      detailLabel: deletedLabel,
      muted: true,
      title: deletedLabel
    }
  }

  return {
    rowLabel: translate(
      'auto.components.automations.runViewState.workspaceGone',
      'Workspace no longer available'
    ),
    detailLabel: translate(
      'auto.components.automations.runViewState.workspaceGone',
      'Workspace no longer available'
    ),
    muted: true
  }
}
