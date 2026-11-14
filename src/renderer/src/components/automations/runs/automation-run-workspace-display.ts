import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { Worktree } from '../../../../../shared/worktree/types'

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
    run: Pick<AutomationRun, 'workspaceId' | 'workspaceDisplayName'>
    worktree: Pick<Worktree, 'displayName'> | null
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

  // Why: one short word in the column; the title keeps which workspace it was.
  const removed = t('auto.components.automations.runWorkspaceDisplay.removed', 'Removed')
  const previousName = run.workspaceDisplayName?.trim()
  return {
    rowLabel: removed,
    detailLabel: removed,
    muted: true,
    title: previousName
      ? t('auto.components.automations.runWorkspaceDisplay.namedRemoved', '{{name}} was removed', {
          name: previousName
        })
      : undefined
  }
}
