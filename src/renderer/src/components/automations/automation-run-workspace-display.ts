import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { Worktree } from '../../../../shared/worktree/types'

export type AutomationRunWorkspaceDisplay = {
  rowLabel: string
  detailLabel: string
  muted: boolean
  title?: string
}

export function getAutomationRunWorkspaceDisplay(
  {
    run,
    worktree
  }: {
    run: AutomationRun
    worktree: Worktree | null
  },
  t: Translate = translate
): AutomationRunWorkspaceDisplay {
  if (!run.workspaceId) {
    return {
      rowLabel: t('auto.components.automations.runWorkspaceDisplay.notLaunched', 'Not launched'),
      detailLabel: t('auto.components.automations.runWorkspaceDisplay.notLaunched', 'Not launched'),
      muted: true
    }
  }
  if (worktree) {
    return {
      rowLabel: run.workspaceDisplayName?.trim() || worktree.displayName,
      detailLabel: run.workspaceDisplayName?.trim() || worktree.displayName,
      muted: false,
      title: run.workspaceDisplayName?.trim() || worktree.displayName
    }
  }

  const previousName = run.workspaceDisplayName?.trim()
  if (previousName) {
    const deletedLabel = t(
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
    rowLabel: t(
      'auto.components.automations.runViewState.workspaceGone',
      'Workspace no longer available'
    ),
    detailLabel: t(
      'auto.components.automations.runViewState.workspaceGone',
      'Workspace no longer available'
    ),
    muted: true
  }
}
