import { useCallback } from 'react'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import type { TodoistTask } from '../../../../../shared/todoist/todoist-types'
import { normalizeTaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { getLinkedWorkItemSuggestedName } from '../../../../../shared/workspace/naming/workspace-name'

export function useTodoistStartWorkspace(
  model: TaskPageComposerActionsModel
): (task: TodoistTask) => void {
  const { fallbackTaskSourceProjectId, openModal } = model
  return useCallback(
    (task: TodoistTask): void => {
      const taskSourceContext = normalizeTaskSourceContext({
        provider: 'todoist',
        projectId: fallbackTaskSourceProjectId,
        // Why: the Todoist token and API calls live in the local main process, whatever runtime is focused.
        hostId: LOCAL_EXECUTION_HOST_ID,
        providerIdentity: {
          provider: 'todoist',
          projectId: task.projectId,
          projectName: task.projectName
        },
        accountLabel: task.projectName
      })
      openModal('new-workspace-composer', {
        linkedWorkItem: {
          type: 'issue',
          provider: 'todoist',
          number: 0,
          title: task.content,
          url: task.url
        },
        taskSourceContext,
        prefilledName: getLinkedWorkItemSuggestedName({ title: task.content }),
        telemetrySource: 'sidebar'
      })
    },
    [fallbackTaskSourceProjectId, openModal]
  )
}
