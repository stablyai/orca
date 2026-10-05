import type { TaskPageMantisBTListEffectsModel } from './use-task-page-mantisbt-list-effects'
import { useCallback } from 'react'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { bindTaskPageMantisBTItemSourceContext } from './task-page-mantisbt-item-source-context'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getMantisBTIssueWorkspaceSeed } from './task-page-source-context'

export type TaskPageMantisBTComposerActionsModel = TaskPageMantisBTListEffectsModel & {
  openComposerForMantisBTItem: (issue: MantisBTIssue) => void
  handleUseMantisBTItem: (issue: MantisBTIssue) => void
}

export function useTaskPageMantisBTComposerActions(
  model: TaskPageMantisBTListEffectsModel
): TaskPageMantisBTComposerActionsModel {
  const { openModal, mantisBTSites, mantisBTTaskSourceContext } = model
  const openComposerForMantisBTItem = useCallback(
    (issue: MantisBTIssue): void => {
      const taskSourceContext = bindTaskPageMantisBTItemSourceContext({
        issue,
        sites: mantisBTSites,
        sourceContext: mantisBTTaskSourceContext
      })
      if (!taskSourceContext) {
        // Why: composer drops MantisBT items without matching source context — refuse rather than create unlinked.
        toast.error(
          translate(
            'auto.components.TaskPage.mantisbtLinkSourceUnavailable',
            'Couldn’t link this MantisBT issue. Reconnect MantisBT or pick the matching site, then try again.'
          )
        )
        return
      }
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'mantisBT',
        number: Number(issue.id),
        title: issue.summary,
        url: issue.url
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: getMantisBTIssueWorkspaceSeed(issue),
        telemetrySource: 'sidebar'
      })
    },
    [mantisBTSites, mantisBTTaskSourceContext, openModal]
  )
  const handleUseMantisBTItem = useCallback(
    (issue: MantisBTIssue): void => {
      useAppStore.getState().recordFeatureInteraction('mantisbt-tasks')
      openComposerForMantisBTItem(issue)
    },
    [openComposerForMantisBTItem]
  )
  return {
    ...model,
    openComposerForMantisBTItem,
    handleUseMantisBTItem
  }
}
