import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { getLinearIssueGridTemplate, groupLinearIssues } from './task-page-linear-jira-list-model'
import type { LinearIssueListRow } from './task-page-linear-issue-model'
import type { TaskPageLinearListProjectionPreludeModel } from './use-task-page-linear-list-projection'

const NO_COLLAPSED_SECTIONS: ReadonlySet<string> = new Set()

export function useTaskPageLinearListPresentation(model: TaskPageLinearListProjectionPreludeModel) {
  const {
    linearDisplayProperties,
    linearGroupBy,
    linearMode,
    linearOrderBy,
    linearProjectTab,
    linearTeamOptions,
    linearTeamPropertyTouched,
    linearTeamSelection,
    pagedLinearIssues,
    selectedLinearCustomView,
    selectedLinearProject
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
  // Section keys repeat across Linear views and groupings, so a carried-over collapse folds a section the user never touched here.
  const linearSectionScopeKey = useMemo(() => {
    if (selectedLinearProject && linearProjectTab === 'issues') {
      return `project:${selectedLinearProject.id}:${linearGroupBy}`
    }
    if (selectedLinearCustomView?.model === 'issue') {
      return `view:${selectedLinearCustomView.id}:${linearGroupBy}`
    }
    return `list:${linearMode}:${linearGroupBy}`
  }, [
    linearGroupBy,
    linearMode,
    linearProjectTab,
    selectedLinearCustomView?.id,
    selectedLinearCustomView?.model,
    selectedLinearProject
  ])
  const [collapsedLinearSections, setCollapsedLinearSections] = useState<{
    scopeKey: string
    keys: ReadonlySet<string>
  }>(() => ({ scopeKey: linearSectionScopeKey, keys: NO_COLLAPSED_SECTIONS }))
  // Read through the scope so a set from the previous list is ignored on the first render of a new one, before the effect below has run.
  const collapsedLinearSectionKeys =
    collapsedLinearSections.scopeKey === linearSectionScopeKey
      ? collapsedLinearSections.keys
      : NO_COLLAPSED_SECTIONS
  // Drop it once the scope has changed, so returning to a list always starts expanded rather than restoring a fold the user cannot see they left behind.
  useEffect(() => {
    setCollapsedLinearSections((current) =>
      current.scopeKey === linearSectionScopeKey
        ? current
        : { scopeKey: linearSectionScopeKey, keys: NO_COLLAPSED_SECTIONS }
    )
  }, [linearSectionScopeKey])
  const toggleLinearSection = useCallback(
    (key: string) => {
      setCollapsedLinearSections((current) => {
        const keys = new Set(
          current.scopeKey === linearSectionScopeKey ? current.keys : NO_COLLAPSED_SECTIONS
        )
        if (!keys.delete(key)) {
          keys.add(key)
        }
        return { scopeKey: linearSectionScopeKey, keys }
      })
    },
    [linearSectionScopeKey]
  )
  const linearIssueListRows = useMemo<LinearIssueListRow[]>(
    () =>
      linearIssueSections.flatMap((section) => {
        const collapsed = linearGroupBy !== 'none' && collapsedLinearSectionKeys.has(section.key)
        const issueRows = collapsed
          ? []
          : section.issues.map((issue) => ({
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
            count: section.issues.length,
            collapsed
          },
          ...issueRows
        ]
      }),
    [collapsedLinearSectionKeys, linearGroupBy, linearIssueSections]
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every widened field is assigned on nextModel immediately below, so the assertion only names what this hook attaches.
  const nextModel = model as typeof model & {
    selectedLinearTeamForExternalLink: typeof selectedLinearTeamForExternalLink
    effectiveLinearDisplayProperties: typeof effectiveLinearDisplayProperties
    linearIssueGridTemplate: typeof linearIssueGridTemplate
    linearIssueGridStyle: typeof linearIssueGridStyle
    linearIssueSections: typeof linearIssueSections
    linearIssueListRows: typeof linearIssueListRows
    toggleLinearSection: typeof toggleLinearSection
  }
  nextModel.selectedLinearTeamForExternalLink = selectedLinearTeamForExternalLink
  nextModel.effectiveLinearDisplayProperties = effectiveLinearDisplayProperties
  nextModel.linearIssueGridTemplate = linearIssueGridTemplate
  nextModel.linearIssueGridStyle = linearIssueGridStyle
  nextModel.linearIssueSections = linearIssueSections
  nextModel.linearIssueListRows = linearIssueListRows
  nextModel.toggleLinearSection = toggleLinearSection
  return nextModel
}

export type TaskPageLinearListPresentationModel = ReturnType<
  typeof useTaskPageLinearListPresentation
>
