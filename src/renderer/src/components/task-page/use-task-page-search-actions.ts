import type { TaskPageGitHubQuietRefreshModel } from './github/refresh/use-task-page-github-quiet-refresh'
import React, { useCallback, useEffect } from 'react'
import type { PRFilterChange } from '@/components/github/PRFilterSections'
import {
  scopeGitHubTaskSearch,
  getDefaultPresetForGitHubTaskKind
} from '../../../../shared/work-items/task-github-search'
import { matchGitHubPRPreset, patchGitHubTaskQuery } from './github/listing/task-page-pr-chips'
import type { TaskViewPresetId } from '../../../../shared/ui-chrome-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { GitHubTaskKind } from '@/components/task-page/task-page-localized-options'
import { getTaskPresetQuery } from '../../../../shared/work-items/task-preset-query'
import { shouldSuppressEnterSubmit } from '@/lib/workspace/creation/new-workspace-enter-guard'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
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
      // Round-trip through parseTaskQuery so dropdown patches preserve other filters and free text.
      const next = patchGitHubTaskQuery(
        scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind),
        change
      )
      // Why: a query equal to a saved PR preset is applied as that preset, or restore, prefetch keys and the phone see an unknown string.
      const preset = activeGithubTaskKind === 'prs' ? matchGitHubPRPreset(next) : null
      const query = preset ? getTaskPresetQuery(preset) : next
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(preset)
      setTaskResumeState({
        githubItemsPreset: preset,
        githubItemsQuery: query
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
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
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
