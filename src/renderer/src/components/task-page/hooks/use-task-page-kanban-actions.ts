import { useCallback } from 'react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import {
  buildKanbanTaskLinkedWorkItem,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  matchKanbanTaskRepository,
  type KanbanRepoCandidate
} from '@/components/task-page-kanban-repo-project-match'
import { findKanbanTaskWorkspaceLink } from '@/components/task-page-kanban-workspace-link'
import {
  buildKanbanTaskStartupDraft,
  getKanbanTaskWorkspaceSeed
} from '@/components/task-page/workspace-seeds'
import {
  KANBAN_SERVER_URL,
  type KanbanTaskDetails,
  type KanbanTaskSummary
} from '../../../../../shared/kanban-types'
import { normalizeTaskSourceContext } from '../../../../../shared/task-source-context'

export function useTaskPageKanbanActions({
  repos,
  openModal
}: {
  repos: readonly KanbanRepoCandidate[]
  openModal: AppState['openModal']
}) {
  const openComposerForKanbanTask = useCallback(
    (task: KanbanTaskSummary): void => {
      const match = matchKanbanTaskRepository({
        repositoryUrls: task.repositoryUrls,
        repos
      })
      const repoId = match.kind === 'unique' ? match.repo.id : undefined
      const taskSourceContext = normalizeTaskSourceContext({
        provider: 'kanban',
        projectId: repoId ?? task.id,
        ...(repoId ? { repoId } : {}),
        providerIdentity: { provider: 'kanban', serverUrl: KANBAN_SERVER_URL }
      })
      const openWithDetails = (details: KanbanTaskDetails | null): void => {
        const linkedWorkItem: LinkedWorkItemSummary = buildKanbanTaskLinkedWorkItem({
          task,
          repoId
        })
        linkedWorkItem.linkedContext = {
          provider: 'kanban',
          version: 1,
          renderedText: buildKanbanTaskStartupDraft({ task, details })
        }
        openModal('new-workspace-composer', {
          linkedWorkItem,
          ...(taskSourceContext ? { taskSourceContext } : {}),
          ...(repoId ? { initialRepoId: repoId } : {}),
          prefilledName: getKanbanTaskWorkspaceSeed(task),
          telemetrySource: 'sidebar'
        })
      }
      void window.api.kanban
        .getTask({ id: task.id })
        .then((details) => openWithDetails(details))
        .catch(() => openWithDetails(null))
    },
    [openModal, repos]
  )

  const handleUseKanbanTask = useCallback(
    (task: KanbanTaskSummary): void => {
      // Why: a workspace already linked to this card is activated before the
      // composer opens and before any Kanban mutation — never create a duplicate.
      const existing = findKanbanTaskWorkspaceLink({
        worktrees: useAppStore.getState().allWorktrees(),
        folderWorkspaces: useAppStore.getState().folderWorkspaces,
        taskId: task.id
      })
      if (existing) {
        // Why: activation must resolve the owner by host — a local and an SSH
        // workspace can share an id, and the bare id alone could open the wrong one.
        if (
          activateAndRevealWorkspace(
            existing.workspaceId,
            existing.executionHostId ? { executionHostId: existing.executionHostId } : undefined
          ) === false
        ) {
          toast.error(
            translate(
              'auto.components.kanban.workspaceOpenFailed',
              "Couldn't open the existing workspace for this Kanban task."
            )
          )
        }
        return
      }
      openComposerForKanbanTask(task)
    },
    [openComposerForKanbanTask]
  )

  return {
    handleUseKanbanTask,
    openComposerForKanbanTask
  }
}