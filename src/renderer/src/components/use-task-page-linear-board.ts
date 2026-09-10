import type { TaskPageLinearListProjectionModel } from './use-task-page-linear-list-projection'
import React, { useMemo, useCallback } from 'react'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import {
  writeLinearBoardIssueDragData,
  readLinearBoardIssueDragData
} from '@/lib/linear-board-drag-payload'
import { linearTeamStates } from '@/runtime/runtime-linear-project-client'
import { linearUpdateIssue } from '@/runtime/runtime-linear-issue-mutations'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { LinearDisplayProperty } from '@/components/task-page-localized-options'
import { groupLinearIssues } from './task-page-linear-jira-list-model'
import type { LinearGroupSection } from './task-page-linear-issue-model'
import {
  findLinearWorkflowStateForStatus,
  getLinearStatusSectionState
} from './task-page-linear-issue-model'
export function useTaskPageLinearBoard(model: TaskPageLinearListProjectionModel) {
  const {
    settings,
    invalidateLinearIssueLists,
    patchLinearIssue,
    linearTaskSourceContext,
    setSelectedLinearIssueFallback,
    linearGroupBy,
    linearOrderBy,
    setLinearDisplayProperties,
    setLinearTeamPropertyTouched,
    linearBoardDraggingIssueId,
    setLinearBoardDraggingIssueId,
    setLinearBoardDragOverKey,
    linearBoardUpdatingIssueIds,
    setLinearBoardUpdatingIssueIds,
    patchScopedLinearIssue,
    filteredLinearIssues,
    pagedLinearIssues
  } = model
  const linearBoardSections = useMemo(
    () =>
      groupLinearIssues(
        pagedLinearIssues,
        linearGroupBy === 'none' ? 'status' : linearGroupBy,
        linearOrderBy
      ),
    [pagedLinearIssues, linearGroupBy, linearOrderBy]
  )
  const linearStatusBoardEnabled = linearGroupBy === 'none' || linearGroupBy === 'status'
  const handleLinearBoardCardDragStart = useCallback(
    (issue: LinearIssue, event: React.DragEvent<HTMLDivElement>) => {
      if (!linearStatusBoardEnabled || linearBoardUpdatingIssueIds.has(issue.id)) {
        event.preventDefault()
        return
      }
      if (!writeLinearBoardIssueDragData(event.dataTransfer, issue.id)) {
        event.preventDefault()
        return
      }
      setLinearBoardDraggingIssueId(issue.id)
    },
    [linearBoardUpdatingIssueIds, linearStatusBoardEnabled, setLinearBoardDraggingIssueId]
  )
  const handleLinearBoardDragOver = useCallback(
    (section: LinearGroupSection, event: React.DragEvent<HTMLElement>) => {
      if (!linearStatusBoardEnabled || !getLinearStatusSectionState(section)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setLinearBoardDragOverKey(section.key)
    },
    [linearStatusBoardEnabled, setLinearBoardDragOverKey]
  )
  const handleLinearBoardDrop = useCallback(
    async (section: LinearGroupSection, event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setLinearBoardDragOverKey(null)
      const targetState = getLinearStatusSectionState(section)
      if (!linearStatusBoardEnabled || !targetState) {
        return
      }
      const draggedIssue = readLinearBoardIssueDragData(event.dataTransfer)
      const issueId =
        draggedIssue.status === 'issue'
          ? draggedIssue.issueId
          : draggedIssue.status === 'hidden'
            ? linearBoardDraggingIssueId
            : null
      const issue = filteredLinearIssues.find((item) => item.id === issueId)
      if (
        !issue ||
        linearBoardUpdatingIssueIds.has(issue.id) ||
        (issue.state.name === targetState.name && issue.state.type === targetState.type)
      ) {
        return
      }
      setLinearBoardUpdatingIssueIds((prev) => {
        const next = new Set(prev)
        next.add(issue.id)
        return next
      })
      const previousState = issue.state
      const applyFallbackState = (state: LinearIssue['state']) => {
        setSelectedLinearIssueFallback((prev) =>
          prev?.id === issue.id
            ? {
                ...prev,
                state
              }
            : prev
        )
      }
      try {
        const states = await linearTeamStates(
          linearTaskSourceContext ?? settings,
          issue.team.id,
          issue.workspaceId
        )
        const workflowState = findLinearWorkflowStateForStatus(states, targetState)
        if (!workflowState) {
          toast.error(
            translate(
              'auto.components.TaskPage.745ae567d4',
              '"{{value0}}" is not available for {{value1}}',
              {
                value0: targetState.name,
                value1: issue.team.name
              }
            )
          )
          return
        }
        const nextState: LinearIssue['state'] = {
          name: workflowState.name,
          type: workflowState.type,
          color: workflowState.color
        }
        patchLinearIssue(
          issue.id,
          {
            state: nextState
          },
          {
            sourceContext: linearTaskSourceContext
          }
        )
        patchScopedLinearIssue(issue.id, {
          state: nextState
        })
        applyFallbackState(nextState)
        const result = await linearUpdateIssue(
          linearTaskSourceContext ?? settings,
          issue.id,
          {
            stateId: workflowState.id
          },
          issue.workspaceId
        )
        if (result.ok === false) {
          patchLinearIssue(
            issue.id,
            {
              state: previousState
            },
            {
              sourceContext: linearTaskSourceContext
            }
          )
          patchScopedLinearIssue(issue.id, {
            state: previousState
          })
          applyFallbackState(previousState)
          toast.error(
            result.error ??
              translate('auto.components.TaskPage.6775c05483', 'Failed to update Linear state')
          )
          return
        }
        invalidateLinearIssueLists({
          sourceContext: linearTaskSourceContext
        })
        useAppStore.getState().recordFeatureInteraction('linear-tasks')
      } catch {
        patchLinearIssue(
          issue.id,
          {
            state: previousState
          },
          {
            sourceContext: linearTaskSourceContext
          }
        )
        patchScopedLinearIssue(issue.id, {
          state: previousState
        })
        applyFallbackState(previousState)
        toast.error(
          translate('auto.components.TaskPage.6775c05483', 'Failed to update Linear state')
        )
      } finally {
        setLinearBoardUpdatingIssueIds((prev) => {
          const next = new Set(prev)
          next.delete(issue.id)
          return next
        })
      }
    },
    [
      filteredLinearIssues,
      invalidateLinearIssueLists,
      linearBoardDraggingIssueId,
      linearBoardUpdatingIssueIds,
      linearStatusBoardEnabled,
      patchScopedLinearIssue,
      patchLinearIssue,
      linearTaskSourceContext,
      settings,
      setLinearBoardDragOverKey,
      setSelectedLinearIssueFallback,
      setLinearBoardUpdatingIssueIds
    ]
  )
  const toggleLinearDisplayProperty = useCallback(
    (property: LinearDisplayProperty): void => {
      if (property === 'team') {
        setLinearTeamPropertyTouched(true)
      }
      setLinearDisplayProperties((prev) => {
        const next = new Set(prev)
        if (next.has(property)) {
          next.delete(property)
        } else {
          next.add(property)
        }
        return next
      })
    },
    [setLinearTeamPropertyTouched, setLinearDisplayProperties]
  )
  const nextModel = model as typeof model & {
    linearBoardSections: typeof linearBoardSections
    linearStatusBoardEnabled: typeof linearStatusBoardEnabled
    handleLinearBoardCardDragStart: typeof handleLinearBoardCardDragStart
    handleLinearBoardDragOver: typeof handleLinearBoardDragOver
    handleLinearBoardDrop: typeof handleLinearBoardDrop
    toggleLinearDisplayProperty: typeof toggleLinearDisplayProperty
  }
  nextModel.linearBoardSections = linearBoardSections
  nextModel.linearStatusBoardEnabled = linearStatusBoardEnabled
  nextModel.handleLinearBoardCardDragStart = handleLinearBoardCardDragStart
  nextModel.handleLinearBoardDragOver = handleLinearBoardDragOver
  nextModel.handleLinearBoardDrop = handleLinearBoardDrop
  nextModel.toggleLinearDisplayProperty = toggleLinearDisplayProperty
  return nextModel
}
export type TaskPageLinearBoardModel = ReturnType<typeof useTaskPageLinearBoard>
