import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getVoloTaskWorkspaceSeed } from '@/components/task-page/workspace-seeds'
import type { VoloTask } from '../../../../../shared/volo-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { AppState } from '@/store/types'

export function useTaskPageVoloActions({
  voloTaskSourceContext,
  openModal
}: {
  voloTaskSourceContext: TaskSourceContext | null
  openModal: AppState['openModal']
}) {
  const handleUseVoloItem = useCallback(
    (task: VoloTask): void => {
      if (!voloTaskSourceContext) {
        toast.error(
          translate(
            'auto.components.TaskPage.voloLinkSourceUnavailable',
            'Couldn’t link this Volo task. Reconnect Volo, then try again.'
          )
        )
        return
      }
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'volo',
        number: 0,
        title: `${task.taskCode} ${task.title}`,
        url: task.url,
        voloIdentifier: task.taskCode
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: voloTaskSourceContext,
        prefilledName: getVoloTaskWorkspaceSeed(task),
        telemetrySource: 'sidebar'
      })
      useAppStore.getState().recordFeatureInteraction('volo-tasks')
    },
    [openModal, voloTaskSourceContext]
  )

  return { handleUseVoloItem }
}
