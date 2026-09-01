import {
  useCallback,
  useEffect,
  type ChangeEvent,
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from 'react'
import { toast } from 'sonner'

import type { PRFilterChange } from '@/components/github/PRFilterDropdowns'
import { useGitHubTaskSearchCommit } from '@/components/use-github-task-search-commit'
import {
  getDefaultPresetForGitHubTaskKind,
  scopeGitHubTaskSearch
} from '@/components/task-page-github-task-kind'
import type { GitHubTaskKind } from '@/components/task-page-localized-options'
import { translate } from '@/i18n/i18n'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import type { AppState } from '@/store/types'
import { getTaskPresetQuery } from '../../../../../shared/task-preset-query'
import { withQualifier } from '../../../../../shared/task-query'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'

export function useTaskPageGitHubSearch({
  activeGithubTaskKind,
  appliedTaskSearch,
  setAppliedTaskSearch,
  setTasksFiltering,
  taskResumeApplied,
  taskSearchInput,
  githubSearchPersistReadyRef,
  setTaskResumeState,
  activeTaskPreset,
  setTaskSearchInput,
  setActiveTaskPreset,
  setTaskRefreshNonce,
  updateSettings,
  taskSource,
  githubMode,
  dialogWorkItem,
  newIssueOpen,
  newLinearProjectOpen,
  newLinearIssueOpen,
  newJiraIssueOpen,
  activeModal,
  taskSearchInputRef
}: {
  activeGithubTaskKind: GitHubTaskKind
  appliedTaskSearch: string
  setAppliedTaskSearch: Dispatch<SetStateAction<string>>
  setTasksFiltering: Dispatch<SetStateAction<boolean>>
  taskResumeApplied: boolean
  taskSearchInput: string
  githubSearchPersistReadyRef: MutableRefObject<boolean>
  setTaskResumeState: AppState['setTaskResumeState']
  activeTaskPreset: TaskViewPresetId | null
  setTaskSearchInput: Dispatch<SetStateAction<string>>
  setActiveTaskPreset: Dispatch<SetStateAction<TaskViewPresetId | null>>
  setTaskRefreshNonce: Dispatch<SetStateAction<number>>
  updateSettings: AppState['updateSettings']
  taskSource: TaskProvider
  githubMode: 'items' | 'project'
  dialogWorkItem: GitHubWorkItem | null
  newIssueOpen: boolean
  newLinearProjectOpen: boolean
  newLinearIssueOpen: boolean
  newJiraIssueOpen: boolean
  activeModal: AppState['activeModal']
  taskSearchInputRef: RefObject<HTMLInputElement | null>
}) {
  const commitTaskSearch = useCallback(
    (value: string): void => {
      const scoped = scopeGitHubTaskSearch(value, activeGithubTaskKind)
      if (scoped !== appliedTaskSearch) {
        setTasksFiltering(true)
      }
      setAppliedTaskSearch(scoped)
    },
    [activeGithubTaskKind, appliedTaskSearch, setTasksFiltering, setAppliedTaskSearch]
  )
  useGitHubTaskSearchCommit({
    enabled: taskResumeApplied,
    onCommit: commitTaskSearch,
    value: taskSearchInput
  })

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!githubSearchPersistReadyRef.current) {
      githubSearchPersistReadyRef.current = true
      return
    }
    // Why: persist the applied query unconditionally to cover paths that change appliedTaskSearch outside the preset handler.
    setTaskResumeState({
      githubItemsPreset: activeTaskPreset,
      githubItemsQuery: appliedTaskSearch.trim()
    })
  }, [
    activeTaskPreset,
    appliedTaskSearch,
    setTaskResumeState,
    taskResumeApplied,
    githubSearchPersistReadyRef
  ])

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
      setTaskResumeState({ githubItemsPreset: null, githubItemsQuery: next })
      // Why: a filter change replaces every row's meaning; show the load skeleton so stale rows don't read as if the filter did nothing.
      setTasksFiltering(true)
      setTaskRefreshNonce((current) => current + 1)
    },
    [
      activeGithubTaskKind,
      setTaskResumeState,
      taskSearchInput,
      setTasksFiltering,
      setAppliedTaskSearch,
      setTaskSearchInput,
      setTaskRefreshNonce,
      setActiveTaskPreset
    ]
  )

  const handleApplyTaskSearch = useCallback((): void => {
    const scoped = scopeGitHubTaskSearch(taskSearchInput, activeGithubTaskKind)
    setTaskSearchInput(scoped)
    setAppliedTaskSearch(scoped)
    setActiveTaskPreset(null)
    setTaskResumeState({ githubItemsPreset: null, githubItemsQuery: scoped })
    setTasksFiltering(true)
    setTaskRefreshNonce((current) => current + 1)
  }, [
    activeGithubTaskKind,
    setTaskResumeState,
    taskSearchInput,
    setAppliedTaskSearch,
    setTasksFiltering,
    setTaskSearchInput,
    setActiveTaskPreset,
    setTaskRefreshNonce
  ])

  const handleTaskSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const next = event.target.value
      setTaskSearchInput(next)
      setActiveTaskPreset(null)
    },
    [setActiveTaskPreset, setTaskSearchInput]
  )

  const handleSetDefaultTaskPreset = useCallback(
    (presetId: TaskViewPresetId): void => {
      // Why: the default task view is a durable preference, so persist it instead of only changing page state.
      void updateSettings({ defaultTaskViewPreset: presetId }).catch(() => {
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
      setTasksFiltering,
      setAppliedTaskSearch,
      setTaskRefreshNonce,
      setTaskSearchInput,
      setActiveTaskPreset
    ]
  )

  const handleResetGithubTaskSearch = useCallback((): void => {
    handleSelectGithubTaskKind(activeGithubTaskKind)
  }, [activeGithubTaskKind, handleSelectGithubTaskKind])

  const handleTaskSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        // React SyntheticEvent does not expose isComposing; use nativeEvent.
        if (
          shouldSuppressEnterSubmit(
            { isComposing: event.nativeEvent.isComposing, shiftKey: event.shiftKey },
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

    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
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

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
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

  return {
    commitTaskSearch,
    applyPRFilterChange,
    handleApplyTaskSearch,
    handleTaskSearchChange,
    handleSetDefaultTaskPreset,
    handleSelectGithubTaskKind,
    handleResetGithubTaskSearch,
    handleTaskSearchKeyDown
  }
}
