import type { TaskPageGitHubQuietRefreshModel } from './github/refresh/use-task-page-github-quiet-refresh'
import React, { useCallback } from 'react'
import type { PRFilterChange } from '@/components/github/PRFilterSections'
import {
  scopeGitHubTaskSearch,
  getDefaultPresetForGitHubTaskKind
} from '../../../../shared/work-items/task-github-search'
import { matchGitHubPRPreset, patchGitHubTaskQuery } from './github/listing/task-page-pr-chips'
import type { TaskViewPresetId } from '../../../../shared/ui-chrome/ui-chrome-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { GitHubTaskKind } from '@/components/task-page/task-page-localized-options'
import { getTaskPresetQuery } from '../../../../shared/work-items/task-preset-query'
import { shouldSuppressEnterSubmit } from '@/lib/workspace/creation/new-workspace-enter-guard'
export function useTaskPageSearchActions(model: TaskPageGitHubQuietRefreshModel) {
  const {
    setTaskResumeState,
    updateSettings,
    taskSearchInput,
    appliedTaskSearch,
    filteredDraftResumeRef,
    setTaskSearchInput,
    setAppliedTaskSearch,
    setActiveTaskPreset,
    setTasksFiltering,
    setTaskRefreshNonce,
    activeGithubTaskKind
  } = model
  const applyPRFilterChange = useCallback(
    (change: PRFilterChange): void => {
      const applied = scopeGitHubTaskSearch(appliedTaskSearch, activeGithubTaskKind)
      const next = patchGitHubTaskQuery(applied, change)
      // Why: a query equal to a saved PR preset is applied as that preset, or restore, prefetch keys and the phone see an unknown string.
      const preset = activeGithubTaskKind === 'prs' ? matchGitHubPRPreset(next) : null
      const query = preset ? getTaskPresetQuery(preset) : next
      // Carry the filter change into a pending draft so its idle submit keeps the filter and the edits.
      const draft = taskSearchInput.trim()
        ? scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind)
        : applied
      const patchedDraft = draft === applied ? query : patchGitHubTaskQuery(draft, change)
      const draftPreset =
        activeGithubTaskKind !== 'prs' || patchedDraft === query
          ? preset
          : matchGitHubPRPreset(patchedDraft)
      const draftQuery = draftPreset ? getTaskPresetQuery(draftPreset) : patchedDraft
      // A filter click used to commit the draft immediately, so resume that click if we leave before idle.
      filteredDraftResumeRef.current =
        draftQuery === query
          ? null
          : { appliedQuery: query, githubItemsPreset: draftPreset, githubItemsQuery: draftQuery }
      setTaskSearchInput(draftQuery)
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
      appliedTaskSearch,
      filteredDraftResumeRef,
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
    filteredDraftResumeRef.current = null
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
    filteredDraftResumeRef,
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
      filteredDraftResumeRef.current = null
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
      filteredDraftResumeRef,
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
  return {
    ...model,
    applyPRFilterChange,
    handleApplyTaskSearch,
    handleTaskSearchChange,
    handleSetDefaultTaskPreset,
    handleSelectGithubTaskKind,
    handleResetGithubTaskSearch,
    handleTaskSearchKeyDown
  }
}
export type TaskPageSearchActionsModel = ReturnType<typeof useTaskPageSearchActions>
