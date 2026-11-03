import type { TaskPageGitHubQuietRefreshModel } from './github/use-task-page-github-quiet-refresh'
import React, { useCallback, useEffect } from 'react'
import {
  scopeGitHubTaskSearch,
  getDefaultPresetForGitHubTaskKind
} from '../../../../shared/task-github-search'
import type { TaskViewPresetId } from '../../../../shared/ui-chrome-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { GitHubTaskKind } from '@/components/task-page/task-page-localized-options'
import { getTaskPresetQuery } from '../../../../shared/task-preset-query'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
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
    handleApplyTaskSearch: typeof handleApplyTaskSearch
    handleTaskSearchChange: typeof handleTaskSearchChange
    handleSetDefaultTaskPreset: typeof handleSetDefaultTaskPreset
    handleSelectGithubTaskKind: typeof handleSelectGithubTaskKind
    handleResetGithubTaskSearch: typeof handleResetGithubTaskSearch
    handleTaskSearchKeyDown: typeof handleTaskSearchKeyDown
  }
  nextModel.handleApplyTaskSearch = handleApplyTaskSearch
  nextModel.handleTaskSearchChange = handleTaskSearchChange
  nextModel.handleSetDefaultTaskPreset = handleSetDefaultTaskPreset
  nextModel.handleSelectGithubTaskKind = handleSelectGithubTaskKind
  nextModel.handleResetGithubTaskSearch = handleResetGithubTaskSearch
  nextModel.handleTaskSearchKeyDown = handleTaskSearchKeyDown
  return nextModel
}
export type TaskPageSearchActionsModel = ReturnType<typeof useTaskPageSearchActions>
