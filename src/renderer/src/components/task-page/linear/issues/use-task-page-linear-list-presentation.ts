import React, { useMemo } from 'react'

import { groupLinearIssues } from './task-page-linear-issue-grouping'

import type { TaskPageLinearListProjectionPreludeModel } from './use-task-page-linear-list-projection'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import type { LinearDisplayProperty } from '../../../../../../shared/linear/issue-view-resume-state'

export function useTaskPageLinearListPresentation(model: TaskPageLinearListProjectionPreludeModel) {
  const {
    linearDisplayProperties,
    linearGroupBy,
    linearOrderBy,
    linearTeamOptions,
    linearTeamPropertyTouched,
    linearTeamSelection,
    pagedLinearIssues
  } = model
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
        const issueRows = section.issues.map((issue) => ({
          type: 'issue' as const,
          issue
        }))
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
  const nextModel = model as typeof model & {
    selectedLinearTeamForExternalLink: typeof selectedLinearTeamForExternalLink
    effectiveLinearDisplayProperties: typeof effectiveLinearDisplayProperties
    linearIssueGridTemplate: typeof linearIssueGridTemplate
    linearIssueGridStyle: typeof linearIssueGridStyle
    linearIssueSections: typeof linearIssueSections
    linearIssueListRows: typeof linearIssueListRows
  }
  nextModel.selectedLinearTeamForExternalLink = selectedLinearTeamForExternalLink
  nextModel.effectiveLinearDisplayProperties = effectiveLinearDisplayProperties
  nextModel.linearIssueGridTemplate = linearIssueGridTemplate
  nextModel.linearIssueGridStyle = linearIssueGridStyle
  nextModel.linearIssueSections = linearIssueSections
  nextModel.linearIssueListRows = linearIssueListRows
  return nextModel
}

export type TaskPageLinearListPresentationModel = ReturnType<
  typeof useTaskPageLinearListPresentation
>

export type LinearIssueListRow =
  | {
      type: 'section'
      key: string
      label: string
      count: number
    }
  | {
      type: 'issue'
      issue: LinearIssue
    }

export function getLinearIssueGridTemplate(
  visibleProperties: ReadonlySet<LinearDisplayProperty>
): string {
  const columns = ['96px', 'minmax(240px,1.55fr)']
  if (visibleProperties.has('labels')) {
    columns.push('minmax(168px,0.9fr)')
  }
  if (visibleProperties.has('team')) {
    columns.push('minmax(172px,0.9fr)')
  }
  if (visibleProperties.has('state')) {
    columns.push('138px')
  }
  if (visibleProperties.has('assignee')) {
    columns.push('64px')
  }
  if (visibleProperties.has('updated')) {
    columns.push('104px')
  }
  // Why: Worktrees is icon-only (open vs start); keep it narrow so issue title keeps the room.
  columns.push('64px')
  return columns.join(' ')
}
