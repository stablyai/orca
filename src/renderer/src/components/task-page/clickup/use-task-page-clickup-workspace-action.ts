import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { bindClickUpTaskSourceContext } from '@/lib/work-items/clickup/clickup-task-source-context'
import { getClickUpTaskWorkspaceSeed } from '@/lib/work-items/clickup/clickup-task-workspace-seed'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { useAppStore } from '@/store'
import type { ClickUpTask, ClickUpWorkspace } from '../../../../../shared/clickup/clickup-types'
import { buildClickUpWorkspaceSource } from '../../../../../shared/new-workspace/workspace-source'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'

type OpenModal = ReturnType<typeof useAppStore.getState>['openModal']

/** "Start workspace" for a ClickUp task: opens the composer linked to the task and its Workspace. */
export function useTaskPageClickUpWorkspaceAction(args: {
  openModal: OpenModal
  workspaces: readonly ClickUpWorkspace[]
  sourceContext: TaskSourceContext | null
}) {
  const { openModal, workspaces, sourceContext } = args
  const handleUseClickUpItem = useCallback(
    (task: ClickUpTask): void => {
      const taskSourceContext = bindClickUpTaskSourceContext({ task, workspaces, sourceContext })
      if (!taskSourceContext) {
        // Why: the composer drops ClickUp items without a matching source context, so refuse rather than create an unlinked workspace.
        toast.error(
          translate(
            'taskProviders.clickup.linkSourceUnavailable',
            'Couldn’t link this ClickUp task. Reconnect ClickUp, then try again.'
          )
        )
        return
      }
      useAppStore.getState().recordFeatureInteraction('clickup-tasks')
      const linkedWorkItem: LinkedWorkItemSummary = buildClickUpWorkspaceSource(task)
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: getClickUpTaskWorkspaceSeed(task),
        telemetrySource: 'sidebar'
      })
    },
    [openModal, sourceContext, workspaces]
  )
  return { handleUseClickUpItem }
}
