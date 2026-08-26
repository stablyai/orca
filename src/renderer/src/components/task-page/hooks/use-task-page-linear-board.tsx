import React, { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  readLinearBoardIssueDragData,
  writeLinearBoardIssueDragData
} from '@/lib/linear-board-drag-payload'
import { linearTeamStates, linearUpdateIssue } from '@/runtime/runtime-linear-client'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearSlice } from '@/store/slices/linear'
import type {
  LinearDisplayProperty,
  LinearGroupBy,
  LinearOrderBy
} from '@/components/task-page-localized-options'
import {
  findLinearWorkflowStateForStatus,
  getLinearIssueGridTemplate,
  getLinearStatusSectionState,
  groupLinearIssues,
  type LinearGroupSection,
  type LinearIssueListRow
} from '@/components/task-page/linear/linear-issue-grouping'

export function useTaskPageLinearBoard({
  linearTeamSelection,
  linearTeamOptions,
  linearDisplayProperties,
  linearGroupBy,
  linearTeamPropertyTouched,
  pagedLinearIssues,
  linearOrderBy,
  linearBoardUpdatingIssueIds,
  linearBoardDraggingIssueId,
  filteredLinearIssues,
  linearTaskSourceContext,
  settings,
  patchLinearIssue,
  patchScopedLinearIssue,
  invalidateLinearIssueLists,
  setLinearBoardDraggingIssueId,
  setLinearBoardDragOverKey,
  setLinearBoardUpdatingIssueIds,
  setSelectedLinearIssueFallback,
  setLinearDisplayProperties,
  setLinearTeamPropertyTouched
}: {
  linearTeamSelection: ReadonlySet<string>
  linearTeamOptions: LinearTeam[]
  linearDisplayProperties: ReadonlySet<LinearDisplayProperty>
  linearGroupBy: LinearGroupBy
  linearTeamPropertyTouched: boolean
  pagedLinearIssues: LinearIssue[]
  linearOrderBy: LinearOrderBy
  linearBoardUpdatingIssueIds: ReadonlySet<string>
  linearBoardDraggingIssueId: string | null
  filteredLinearIssues: LinearIssue[]
  linearTaskSourceContext: TaskSourceContext | null
  settings: GlobalSettings | null
  patchLinearIssue: LinearSlice['patchLinearIssue']
  patchScopedLinearIssue: (issueId: string, patch: Partial<LinearIssue>) => void
  invalidateLinearIssueLists: LinearSlice['invalidateLinearIssueLists']
  setLinearBoardDraggingIssueId: Dispatch<SetStateAction<string | null>>
  setLinearBoardDragOverKey: Dispatch<SetStateAction<string | null>>
  setLinearBoardUpdatingIssueIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  setSelectedLinearIssueFallback: Dispatch<SetStateAction<LinearIssue | null>>
  setLinearDisplayProperties: Dispatch<SetStateAction<ReadonlySet<LinearDisplayProperty>>>
  setLinearTeamPropertyTouched: Dispatch<SetStateAction<boolean>>
}) {
  const selectedLinearTeamForExternalLink = useMemo(() => {
    if (linearTeamSelection.size !== 1) {
      return null
    }
    const [teamId] = linearTeamSelection
    return linearTeamOptions.find((team) => team.id === teamId && team.url) ?? null
  }, [linearTeamOptions, linearTeamSelection])

  const effectiveLinearDisplayProperties = useMemo(() => {
    const next = new Set(linearDisplayProperties)
    const groupedProperty =
      linearGroupBy === 'status'
        ? 'state'
        : linearGroupBy === 'assignee' || linearGroupBy === 'priority' || linearGroupBy === 'team'
          ? linearGroupBy
          : null
    if (groupedProperty) {
      next.delete(groupedProperty)
    }

    // Why: a Team column repeats the same value when one team is selected; keep it hidden until the user opts back in.
    if (linearTeamSelection.size <= 1 && !linearTeamPropertyTouched) {
      next.delete('team')
    } else if (linearTeamSelection.size > 1 && !linearTeamPropertyTouched) {
      next.add('team')
    }
    return next
  }, [linearDisplayProperties, linearGroupBy, linearTeamPropertyTouched, linearTeamSelection.size])
  const linearIssueGridTemplate = useMemo(
    () => getLinearIssueGridTemplate(effectiveLinearDisplayProperties),
    [effectiveLinearDisplayProperties]
  )
  const linearIssueGridStyle = useMemo(
    () =>
      ({
        '--linear-grid-template': linearIssueGridTemplate
      }) as React.CSSProperties,
    [linearIssueGridTemplate]
  )
  const linearIssueSections = useMemo(
    () => groupLinearIssues(pagedLinearIssues, linearGroupBy, linearOrderBy),
    [pagedLinearIssues, linearGroupBy, linearOrderBy]
  )
  const linearIssueListRows = useMemo<LinearIssueListRow[]>(
    () =>
      linearIssueSections.flatMap((section) => {
        const issueRows = section.issues.map((issue) => ({ type: 'issue' as const, issue }))
        if (linearGroupBy === 'none') {
          return issueRows
        }
        return [
          {
            type: 'section' as const,
            key: section.key,
            label: section.label,
            count: section.issues.length
          },
          ...issueRows
        ]
      }),
    [linearGroupBy, linearIssueSections]
  )
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

  // Why: two drops resolving in the same render pass both read the stale state set; the ref settles first.
  const linearBoardInFlightIssueIdsRef = useRef<Set<string>>(new Set())

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
        linearBoardInFlightIssueIdsRef.current.has(issue.id) ||
        (issue.state.name === targetState.name && issue.state.type === targetState.type)
      ) {
        return
      }
      linearBoardInFlightIssueIdsRef.current.add(issue.id)

      setLinearBoardUpdatingIssueIds((prev) => {
        const next = new Set(prev)
        next.add(issue.id)
        return next
      })

      const previousState = issue.state
      const applyFallbackState = (state: LinearIssue['state']) => {
        setSelectedLinearIssueFallback((prev) =>
          prev?.id === issue.id ? { ...prev, state } : prev
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
              { value0: targetState.name, value1: issue.team.name }
            )
          )
          return
        }

        const nextState: LinearIssue['state'] = {
          name: workflowState.name,
          type: workflowState.type,
          color: workflowState.color
        }

        patchLinearIssue(issue.id, { state: nextState }, { sourceContext: linearTaskSourceContext })
        patchScopedLinearIssue(issue.id, { state: nextState })
        applyFallbackState(nextState)

        const result = await linearUpdateIssue(
          linearTaskSourceContext ?? settings,
          issue.id,
          { stateId: workflowState.id },
          issue.workspaceId
        )
        if (result.ok === false) {
          patchLinearIssue(
            issue.id,
            { state: previousState },
            { sourceContext: linearTaskSourceContext }
          )
          patchScopedLinearIssue(issue.id, { state: previousState })
          applyFallbackState(previousState)
          toast.error(
            result.error ??
              translate('auto.components.TaskPage.6775c05483', 'Failed to update Linear state')
          )
          return
        }
        invalidateLinearIssueLists({ sourceContext: linearTaskSourceContext })
        useAppStore.getState().recordFeatureInteraction('linear-tasks')
      } catch {
        patchLinearIssue(
          issue.id,
          { state: previousState },
          { sourceContext: linearTaskSourceContext }
        )
        patchScopedLinearIssue(issue.id, { state: previousState })
        applyFallbackState(previousState)
        toast.error(
          translate('auto.components.TaskPage.6775c05483', 'Failed to update Linear state')
        )
      } finally {
        linearBoardInFlightIssueIdsRef.current.delete(issue.id)
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
      linearStatusBoardEnabled,
      patchScopedLinearIssue,
      patchLinearIssue,
      linearTaskSourceContext,
      settings,

      setLinearBoardDragOverKey,
      setLinearBoardUpdatingIssueIds,
      setSelectedLinearIssueFallback
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

  return {
    selectedLinearTeamForExternalLink,
    effectiveLinearDisplayProperties,
    linearIssueGridTemplate,
    linearIssueGridStyle,
    linearIssueSections,
    linearIssueListRows,
    linearBoardSections,
    linearStatusBoardEnabled,
    handleLinearBoardCardDragStart,
    handleLinearBoardDragOver,
    handleLinearBoardDrop,
    toggleLinearDisplayProperty
  }
}
