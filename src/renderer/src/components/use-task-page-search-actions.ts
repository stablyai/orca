import type { TaskPageGitHubQuietRefreshModel } from './use-task-page-github-quiet-refresh'
import React, { useCallback, useEffect } from 'react'
import type { PRFilterChange } from '@/components/github/PRFilterDropdowns'
import {
  scopeGitHubTaskSearch,
  getDefaultPresetForGitHubTaskKind
} from '@/components/task-page-github-task-kind'
import { withQualifier } from '../../../shared/task-query'
import type { TaskViewPresetId } from '../../../shared/ui-chrome-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { GitHubTaskKind } from '@/components/task-page-localized-options'
import { getTaskPresetQuery } from '../../../shared/task-preset-query'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
export function useTaskPageSearchActions(model: TaskPageGitHubQuietRefreshModel) {
  const {
    setTaskResumeState,
    activeModal,
    updateSettings,
    taskSource,
    githubMode,
    taskSearchInput,
    setTaskSearchInput,
    setAppliedTaskSearch,
    taskSearchInputRef,
    setActiveTaskPreset,
    setTasksFiltering,
    setTaskRefreshNonce,
    dialogWorkItem,
    newIssueOpen,
    newLinearProjectOpen,
    newLinearIssueOpen,
    activeGithubTaskKind,
    newJiraIssueOpen
  } = model
  const applyPRFilterChange = useCallback(
    (change: PRFilterChange): void => {
      let next = scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind)
      // Why: withQualifier round-trips through parseTaskQuery so each dropdown's patch preserves prior filters and free-text.
      if ('author' in change) {
        next = withQualifier(next, 'author', change.author ?? null)
      }
      if ('assignee' in change) {
        next = withQualifier(next, 'assignee', change.assignee ?? null)
      }
      if ('labels' in change) {
        next = withQualifier(next, 'labels', change.labels ?? [])
      }
      if ('state' in change && change.state) {
        next = withQualifier(next, 'state', change.state)
        if (change.state !== 'open') {
          next = withQualifier(next, 'draft', null)
        }
      }
      if ('draft' in change) {
        next = withQualifier(next, 'draft', change.draft ? 'true' : 'false')
      }
      if ('reviewer' in change) {
        // Why: the two reviewer qualifiers are mutually exclusive — clear the other whenever one is set so the chip matches the query.
        const reviewer = change.reviewer ?? null
        if (reviewer === null) {
          next = withQualifier(next, 'reviewRequested', null)
          next = withQualifier(next, 'reviewedBy', null)
        } else if (reviewer.kind === 'requested') {
          next = withQualifier(next, 'reviewedBy', null)
          next = withQualifier(next, 'reviewRequested', reviewer.login)
        } else {
          next = withQualifier(next, 'reviewRequested', null)
          next = withQualifier(next, 'reviewedBy', reviewer.login)
        }
      }
      setTaskSearchInput(next)
      setAppliedTaskSearch(next)
      setActiveTaskPreset(null)
      setTaskResumeState({
        githubItemsPreset: null,
        githubItemsQuery: next
      })
      // Why: a filter change replaces every row's meaning; show the load skeleton so stale rows don't read as if the filter did nothing.
      setTasksFiltering(true)
      setTaskRefreshNonce((current) => current + 1)
    },
    [
      activeGithubTaskKind,
      setTaskResumeState,
      taskSearchInput,
      setActiveTaskPreset,
      setTasksFiltering,
      setTaskSearchInput,
      setTaskRefreshNonce,
      setAppliedTaskSearch
    ]
  )
  const handleApplyTaskSearch = useCallback((): void => {
    const scoped = scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind)
    setTaskSearchInput(scoped)
    setAppliedTaskSearch(scoped)
    setActiveTaskPreset(null)
    setTaskResumeState({
      githubItemsPreset: null,
      githubItemsQuery: scoped
    })
    setTasksFiltering(true)
    setTaskRefreshNonce((current) => current + 1)
  }, [
    activeGithubTaskKind,
    setTaskResumeState,
    taskSearchInput,
    setTasksFiltering,
    setTaskSearchInput,
    setTaskRefreshNonce,
    setAppliedTaskSearch,
    setActiveTaskPreset
  ])
  const handleTaskSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const next = event.target.value
      setTaskSearchInput(next)
      setActiveTaskPreset(null)
    },
    [setTaskSearchInput, setActiveTaskPreset]
  )
  const handleSetDefaultTaskPreset = useCallback(
    (presetId: TaskViewPresetId): void => {
      // Why: the default task view is a durable preference, so persist it instead of only changing page state.
      void updateSettings({
        defaultTaskViewPreset: presetId
      }).catch(() => {
        toast.error(
          translate('auto.components.TaskPage.fe380f306c', 'Failed to save default task view.')
        )
      })
    },
    [updateSettings]
  )
  const handleSelectGithubTaskKind = useCallback(
    (kind: GitHubTaskKind): void => {
      const preset = getDefaultPresetForGitHubTaskKind(kind)
      const query = getTaskPresetQuery(preset)
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(preset)
      setTaskResumeState({
        githubItemsPreset: preset,
        githubItemsQuery: query
      })
      setTasksFiltering(true)
      setTaskRefreshNonce((current) => current + 1)
    },
    [
      setTaskResumeState,
      setActiveTaskPreset,
      setTasksFiltering,
      setTaskSearchInput,
      setTaskRefreshNonce,
      setAppliedTaskSearch
    ]
  )
  const handleResetGithubTaskSearch = useCallback((): void => {
    handleSelectGithubTaskKind(activeGithubTaskKind)
  }, [activeGithubTaskKind, handleSelectGithubTaskKind])
  const handleTaskSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        // React SyntheticEvent does not expose isComposing; use nativeEvent.
        if (
          shouldSuppressEnterSubmit(
            {
              isComposing: event.nativeEvent.isComposing,
              shiftKey: event.shiftKey
            },
            false
          )
        ) {
          return
        }
        event.preventDefault()
        handleApplyTaskSearch()
      }
    },
    [handleApplyTaskSearch]
  )
  useEffect(() => {
    if (
      taskSource !== 'github' ||
      githubMode !== 'items' ||
      dialogWorkItem ||
      newIssueOpen ||
      newLinearProjectOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
      activeModal !== 'none'
    ) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const isMac = navigator.userAgent.includes('Mac')
      const modifierPressed = isMac ? event.metaKey : event.ctrlKey
      if (!modifierPressed || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
        return
      }
      const input = taskSearchInputRef.current
      if (!input) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target !== input &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', onKeyDown, {
      capture: true
    })
    return () =>
      window.removeEventListener('keydown', onKeyDown, {
        capture: true
      })
  }, [
    activeModal,
    dialogWorkItem,
    githubMode,
    newIssueOpen,
    newLinearProjectOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    taskSource,
    taskSearchInputRef
  ])
  const nextModel = model as typeof model & {
    applyPRFilterChange: typeof applyPRFilterChange
    handleApplyTaskSearch: typeof handleApplyTaskSearch
    handleTaskSearchChange: typeof handleTaskSearchChange
    handleSetDefaultTaskPreset: typeof handleSetDefaultTaskPreset
    handleSelectGithubTaskKind: typeof handleSelectGithubTaskKind
    handleResetGithubTaskSearch: typeof handleResetGithubTaskSearch
    handleTaskSearchKeyDown: typeof handleTaskSearchKeyDown
  }
  nextModel.applyPRFilterChange = applyPRFilterChange
  nextModel.handleApplyTaskSearch = handleApplyTaskSearch
  nextModel.handleTaskSearchChange = handleTaskSearchChange
  nextModel.handleSetDefaultTaskPreset = handleSetDefaultTaskPreset
  nextModel.handleSelectGithubTaskKind = handleSelectGithubTaskKind
  nextModel.handleResetGithubTaskSearch = handleResetGithubTaskSearch
  nextModel.handleTaskSearchKeyDown = handleTaskSearchKeyDown
  return nextModel
}
export type TaskPageSearchActionsModel = ReturnType<typeof useTaskPageSearchActions>
