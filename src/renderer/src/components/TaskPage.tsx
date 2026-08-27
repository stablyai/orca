/* eslint-disable max-lines -- Why: repo selector, task-source controls, and task list stay co-located so their wiring reads in one place. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'

import { useAppStore } from '@/store'

import { parseTaskQuery, stripRepoQualifiers, withQualifier } from '../../../shared/task-query'
import type { PRFilterChange } from '@/components/github/PRFilterDropdowns'

import {
  overlayPendingOnTaskPagePages,
  patchTaskPageGitHubWorkItemPages
} from '@/components/task-page-github-work-item-mutations'

import type { ItemDialogTab } from '@/components/GitHubItemDialog'
import { getTaskPresetQuery } from '../../../shared/task-preset-query'

import {
  buildTaskPageRepoSourceState,
  findTaskPageDialogWorkItem,
  reconcileTaskPagePagesWithWorkItemsCache,
  selectTaskPageUnresolvedSourceRepos,
  selectTaskPageWorkItemsCacheEntries,
  type TaskPageRepoSourceState
} from '@/components/task-page-cache-selectors'
import { shouldHideTaskPageListChrome } from '@/components/task-page-list-chrome-visibility'
import { taskPageGitHubResumeCache } from '@/components/task-page-github-resume-cache'
import {
  filterLinearIssuesForInOrcaWorkspace,
  readLinkedLinearIssuesWithLimit
} from '@/components/task-page-linear-in-orca-issues'
import { serializeLinearIssueViewResumeState } from '../../../shared/linear/issue-view-resume-state'
import { saveLinearIssueView } from './linear-issue-view-storage'

import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'

import type { LinearIssue } from '../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import type { LinearCollectionResult } from '../../../shared/linear/workspace-types'
import type { TaskViewPresetId } from '../../../shared/ui-chrome-types'
import { clampLinearIssueListLimit } from '../../../shared/linear/issue-read-limits'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'

import { translate } from '@/i18n/i18n'
import type { GitHubTaskKind } from '@/components/task-page-localized-options'
import { useGitHubTaskSearchCommit } from '@/components/use-github-task-search-commit'
import {
  getDefaultPresetForGitHubTaskKind,
  getGitHubTaskKind,
  scopeGitHubTaskSearch
} from '@/components/task-page-github-task-kind'

import {
  LINEAR_ITEM_LIMIT,
  TASK_SEARCH_DEBOUNCE_MS
} from '@/components/task-page/task-page-list-limits'

import {
  getTaskPageRepoCacheInput,
  getTaskPageRepoSourceContext
} from '@/components/task-page/source/repo-source-context'

import {
  LINEAR_CUSTOM_VIEW_MODELS,
  mergeLinearCollectionResults
} from '@/components/task-page/linear/linear-issue-grouping'

import type { TaskPageSourceToolbarProps } from '@/components/task-page/chrome/task-page-source-toolbar'
import type { TaskPageGithubModeBarProps } from '@/components/task-page/chrome/task-page-github-mode-bar'
import type { TaskPageGithubItemFiltersProps } from '@/components/task-page/chrome/task-page-github-item-filters'
import type { TaskPageLinearFiltersProps } from '@/components/task-page/chrome/task-page-linear-filters'
import type { TaskPageJiraFiltersProps } from '@/components/task-page/chrome/task-page-jira-filters'
import type { TaskPageGitlabFiltersProps } from '@/components/task-page/chrome/task-page-gitlab-filters'
import type { GithubDetailHostProps } from '@/components/task-page/github/github-detail-host'
import type { GithubWorkItemTableProps } from '@/components/task-page/github/github-work-item-table'
import type { GitlabWorkItemListProps } from '@/components/task-page/gitlab/gitlab-work-item-list'
import type { JiraIssueListHostProps } from '@/components/task-page/jira/jira-issue-list-host'
import type { NewGithubIssueDialogProps } from '@/components/task-page/dialogs/new-github-issue-dialog'
import type { NewLinearProjectDialogProps } from '@/components/task-page/dialogs/new-linear-project-dialog'
import type { NewLinearIssueDialogProps } from '@/components/task-page/dialogs/new-linear-issue-dialog'
import type { NewJiraIssueDialogProps } from '@/components/task-page/dialogs/new-jira-issue-dialog'
import type { TaskPageConnectDialogsProps } from '@/components/task-page/dialogs/task-page-connect-dialogs'
import type { LinearViewsHostProps } from '@/components/task-page/linear/linear-views-host'
import { useTaskPageStoreBindings } from '@/components/task-page/hooks/use-task-page-store-bindings'
import { useTaskPageRepoSelection } from '@/components/task-page/source/use-task-page-repo-selection'
import { useTaskPageAccountScopes } from '@/components/task-page/hooks/use-task-page-account-scopes'
import { useTaskPageVisibleSources } from '@/components/task-page/hooks/use-task-page-visible-sources'
import { useTaskPageTaskSourceState } from '@/components/task-page/hooks/use-task-page-task-source-state'
import { useTaskPageRuntimePreflight } from '@/components/task-page/hooks/use-task-page-runtime-preflight'
import { useTaskPageSourceAvailability } from '@/components/task-page/hooks/use-task-page-source-availability'
import { useTaskPageSourceNotices } from '@/components/task-page/hooks/use-task-page-source-notices'
import { useTaskPageSourceSync } from '@/components/task-page/hooks/use-task-page-source-sync'
import { useTaskPageGitLabListState } from '@/components/task-page/hooks/use-task-page-gitlab-list-state'
import { useTaskPageGitHubListState } from '@/components/task-page/hooks/use-task-page-github-list-state'
import { useTaskPageLinearListState } from '@/components/task-page/hooks/use-task-page-linear-list-state'
import { useTaskPageJiraListState } from '@/components/task-page/hooks/use-task-page-jira-list-state'
import { useTaskPageGitLabFetch } from '@/components/task-page/hooks/use-task-page-gitlab-fetch'
import { useTaskPageGitHubNewIssueState } from '@/components/task-page/hooks/use-task-page-github-new-issue-state'
import { useTaskPageSessionResume } from '@/components/task-page/hooks/use-task-page-session-resume'
import { useTaskPageSelectedIssueState } from '@/components/task-page/hooks/use-task-page-selected-issue-state'
import { useTaskPageLinearTeams } from '@/components/task-page/hooks/use-task-page-linear-teams'
import { useTaskPageJiraProjects } from '@/components/task-page/hooks/use-task-page-jira-projects'
import { useTaskPageLinearActiveCollection } from '@/components/task-page/hooks/use-task-page-linear-active-collection'
import { useTaskPageLinearBoard } from '@/components/task-page/hooks/use-task-page-linear-board'
import { useTaskPageLinearCreateDialogs } from '@/components/task-page/hooks/use-task-page-linear-create-dialogs'
import { useTaskPageGitHubMutationSession } from '@/components/task-page/hooks/use-task-page-github-mutation-session'
import { useTaskPageCreateGithubSubmit } from '@/components/task-page/hooks/use-task-page-create-github-submit'
import { useTaskPageLinearFetch } from '@/components/task-page/hooks/use-task-page-linear-fetch'
import { useTaskPageLinearIssueWindow } from '@/components/task-page/hooks/use-task-page-linear-issue-window'
import { useTaskPageLinearActions } from '@/components/task-page/hooks/use-task-page-linear-actions'
import { useTaskPageJiraFetch } from '@/components/task-page/hooks/use-task-page-jira-fetch'
import { useTaskPageJiraActions } from '@/components/task-page/hooks/use-task-page-jira-actions'
import { useTaskPageGitHubFilteredItems } from '@/components/task-page/hooks/use-task-page-github-filtered-items'
import { useTaskPageGitHubPageLoader } from '@/components/task-page/hooks/use-task-page-github-page-loader'
import { useTaskPageCreateLinearSubmits } from '@/components/task-page/hooks/use-task-page-create-linear-submits'
import { useTaskPageCreateJiraSubmit } from '@/components/task-page/hooks/use-task-page-create-jira-submit'
import { useTaskPageJiraDisplayedIssues } from '@/components/task-page/hooks/use-task-page-jira-displayed-issues'
import { useTaskPageJiraCreateDialog } from '@/components/task-page/hooks/use-task-page-jira-create-dialog'
import { useTaskPageCreateDialogResets } from '@/components/task-page/hooks/use-task-page-create-dialog-resets'
import { useTaskPageUseItemActions } from '@/components/task-page/hooks/use-task-page-use-item-actions'
import { TaskPageLayout } from '@/components/task-page/task-page-layout'
import { useTaskPageGitHubFetch } from '@/components/task-page/hooks/use-task-page-github-fetch'
import { useTaskPageGitHubQuietRevalidate } from '@/components/task-page/hooks/use-task-page-github-quiet-revalidate'

export default function TaskPage(): React.JSX.Element {
  const {
    settings,
    persistedUIReady,
    taskResumeState,
    setTaskResumeState,
    pageData,
    openTaskPage,
    closeTaskPage,
    activeModal,
    repos,
    sshConnectionStates,
    sshTargetLabels,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    repoMap,
    allWorktrees,
    openModal,
    updateSettings,
    fetchWorkItemsAcrossRepos,
    fetchPRChecks,
    getCachedWorkItems,
    setIssueSourcePreference,
    workItemsInvalidationNonce,
    linearStatus,
    linearStatusContextKey,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    selectLinearWorkspace,
    searchLinearIssues,
    listLinearIssues,
    linearListInvalidationToken,
    folderWorkspaces,
    invalidateLinearIssueLists,
    getCachedLinearIssues,
    fetchLinearIssue,
    refreshLinearIssue,
    getCachedLinearTeams,
    listLinearTeams,
    getCachedLinearProjects,
    listLinearProjectsFromStore,
    fetchLinearProject,
    listLinearProjectIssues,
    getCachedLinearCustomViews,
    listLinearCustomViews,
    fetchLinearCustomView,
    listLinearCustomViewIssues,
    listLinearCustomViewProjects,
    patchLinearIssue,
    checkLinearConnection,
    refreshPreflightStatus,
    expectedPreflightContextKey,
    jiraStatus,
    jiraStatusContextKey,
    selectJiraSite,
    searchJiraIssues,
    listJiraIssues,
    checkJiraConnection,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    preflightStatusCurrent,
    linearStatusReady,
    jiraStatusReady,
    linearConnected,
    jiraConnected,
    submitShortcutLabel,
    eligibleRepos
  } = useTaskPageStoreBindings()

  const {
    resolvedInitialSelection,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    selectedRepos,
    selectedReposKey,
    primaryRepo
  } = useTaskPageRepoSelection({
    eligibleRepos,
    pageDataPreselectedRepoId: pageData.preselectedRepoId,
    defaultRepoSelection: settings?.defaultRepoSelection
  })
  const {
    linearWorkspaces,
    selectedLinearWorkspaceId,
    selectedLinearWorkspace,
    jiraSites,
    selectedJiraSiteId,
    selectedJiraSite
  } = useTaskPageAccountScopes({ linearStatus, jiraStatus })
  const {
    visibleTaskProviders,
    sourceOptions,
    githubModeButtons,
    linearModeOptions,
    jiraPresets,
    gitLabIssueFilters,
    gitLabMRFilters,
    linearViewOptions,
    linearGroupOptions,
    linearOrderOptions,
    linearDisplayPropertyOptions,
    visibleSourceOptions,
    hideTaskSource,
    defaultTaskViewPreset,
    initialTaskQuery,
    preferredTaskSource
  } = useTaskPageVisibleSources({
    settings,
    preflightStatusCurrent,
    preflightStatus,
    linearConnected,
    updateSettings,
    pageData
  })
  const { taskSource, setTaskSource } = useTaskPageTaskSourceState({
    preferredTaskSource,
    visibleTaskProviders
  })
  const {
    runtimePreflightStatusByHostId,
    taskSourceRepoContexts,
    hostRegistryById,
    hostLabelById,
    getTaskPickerRepoHostLabel
  } = useTaskPageRuntimePreflight({
    taskSource,
    selectedRepos,
    repos,
    settings,
    sshTargetLabels,
    sshConnectionStates,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId
  })
  const {
    taskSourceHostAvailability,
    accountBackedTaskSourceHostId,
    linearTaskSourceContext,
    linearListInvalidationVersionForSource,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    accountBackedTaskSourceHostAvailability
  } = useTaskPageSourceAvailability({
    taskSource,
    selectedRepos,
    hostRegistryById,
    taskSourceRepoContexts,
    runtimePreflightStatusByHostId,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusCurrent,
    settings,
    linearListInvalidationToken,
    providerRuntimeContextKey,
    selectedLinearWorkspace,
    selectedLinearWorkspaceId,
    selectedJiraSite,
    selectedJiraSiteId
  })
  const {
    taskSourceAvailabilityNoticeByProvider,
    taskSourceContextSummary,
    taskSourceAvailabilityNotice,
    githubEmptyState
  } = useTaskPageSourceNotices({
    taskSource,
    selectedRepos,
    hostRegistryById,
    hostLabelById,
    preflightStatus,
    preflightStatusCurrent,
    preflightStatusChecked,
    runtimePreflightStatusByHostId,
    taskSourceRepoContexts,
    accountBackedTaskSourceHostId,
    accountBackedTaskSourceHostAvailability,
    taskSourceHostAvailability,
    selectedLinearWorkspace,
    selectedJiraSite,
    sourceOptions
  })
  const {
    taskSourceManuallyChangedRef,
    taskResumeAppliedRef,
    githubSearchPersistReadyRef,
    linearSearchPersistReadyRef,
    linearViewPersistReadyRef,
    jiraSearchPersistReadyRef,
    taskResumeApplied,
    setTaskResumeApplied
  } = useTaskPageSourceSync({
    pageData,
    preferredTaskSource,
    taskSource,
    setTaskSource,
    visibleTaskProviders,
    settings
  })

  // Why: Project mode is a GitHub sub-tab — visible on the GitHub source, but actual entry is gated on a non-null activeProject.
  const projectModeVisible = taskSource === 'github'
  const [githubMode, setGithubMode] = useState<'items' | 'project'>('items')

  const {
    setGitlabFilter,
    gitlabItems,
    setGitlabItems,
    gitlabLoading,
    setGitlabLoading,
    gitlabError,
    setGitlabError,
    gitlabRefreshNonce,
    setGitlabRefreshNonce,
    gitlabDialogItem,
    setGitlabDialogItem,
    gitlabView,
    setGitlabView,
    gitlabTodos,
    setGitlabTodos,
    gitlabTodosLoading,
    setGitlabTodosLoading,
    gitlabEmptyState,
    activeGitlabFilter,
    displayedGitLabItems
  } = useTaskPageGitLabListState({ selectedRepos })
  const {
    taskSearchInput,
    setTaskSearchInput,
    appliedTaskSearch,
    setAppliedTaskSearch,
    taskSearchInputRef,
    activeTaskPreset,
    setActiveTaskPreset,
    tasksLoading,
    setTasksLoading,
    tasksRefreshing,
    setTasksRefreshing,
    tasksFiltering,
    setTasksFiltering,
    tasksError,
    setTasksError,
    failedCount,
    setFailedCount,
    githubUnavailable,
    setGithubUnavailable,
    taskRefreshNonce,
    setTaskRefreshNonce,
    quietRefreshNonce,
    setQuietRefreshNonce,
    githubViewerLogin,
    setGitHubViewerLogin,
    lastFetchedNonceRef,
    lastFetchedInvalidationNonceRef,
    paginationGenerationRef,
    landingGitHubRefreshKeysRef,
    githubPerRepoPageLimit,
    githubPageSize,
    githubResumeContextKey,
    pages,
    setPages,
    currentPage,
    setCurrentPage,
    pagesRef,
    currentPageRef,
    githubResumeConsumedRef,
    githubResumeContextRef,
    githubListScrollRef,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef,
    paginationLoading,
    setPaginationLoading,
    loadingTargetPage,
    setLoadingTargetPage,
    countedTotalPages,
    setCountedTotalPages,
    provenPageLimit,
    setProvenPageLimit,
    countedTotalPagesRef,
    hardRefreshEpochRef,
    fetchWorkItemsNextPage,
    countWorkItemsAcrossRepos
  } = useTaskPageGitHubListState({
    initialTaskQuery,
    defaultTaskViewPreset,
    selectedRepos,
    selectedReposKey,
    getCachedWorkItems
  })

  useEffect(() => {
    const page = pages[currentPage]
    if (!taskResumeApplied || taskSource !== 'github' || githubMode !== 'items' || !page) {
      return
    }
    taskPageGitHubResumeCache.write(githubResumeContextKey, currentPage, page)
  }, [currentPage, githubMode, githubResumeContextKey, pages, taskResumeApplied, taskSource])

  const taskListPositionRef = useRef<{
    contextKey: string
    page: number
    scrollTop: number
  } | null>(null)

  useLayoutEffect(() => {
    if (
      taskSource !== 'github' ||
      githubMode !== 'items' ||
      pageData.openGitHubWorkItem ||
      pendingGithubScrollRestoreRef.current !== null
    ) {
      return
    }
    taskListPositionRef.current = {
      contextKey: githubResumeContextKey,
      page: currentPage,
      scrollTop: githubListScrollTopRef.current
    }
  }, [
    currentPage,
    githubMode,
    githubResumeContextKey,
    pageData.openGitHubWorkItem,
    taskSource,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef
  ])

  useEffect(
    () => () => {
      const position = taskListPositionRef.current
      const state = useAppStore.getState()
      if (position && !state.taskPageData.openGitHubWorkItem) {
        state.setTaskListPosition({
          contextKey: position.contextKey,
          page: position.page,
          scrollTop: position.scrollTop
        })
      }
    },
    []
  )

  // Why: keyed on selectedReposKey, not the selectedRepos array — a background
  // repos:changed refresh mid-flight would otherwise bump the generation and
  // silently discard the user's page navigation (#11485). Mirrors every dep of
  // the fetch effect that resets page state, so a reset always invalidates
  // in-flight page requests.
  useEffect(() => {
    paginationGenerationRef.current += 1
    setPaginationLoading(false)
    setLoadingTargetPage(null)
  }, [
    selectedReposKey,
    appliedTaskSearch,
    workItemsInvalidationNonce,
    taskRefreshNonce,
    taskSource,
    githubMode,
    taskResumeApplied,

    setPaginationLoading,
    paginationGenerationRef,
    setLoadingTargetPage
  ])

  // Why: the dialog's "Use" button routes through the same direct-launch flow as the row-level "Use" CTA so behavior is consistent regardless of entry point.
  const githubTaskDrawerWorkItem = useAppStore((s) => s.githubTaskDrawerWorkItem)
  const setGithubTaskDrawerWorkItem = useAppStore((s) => s.setGithubTaskDrawerWorkItem)
  const [dialogInitialTab, setDialogInitialTab] = useState<ItemDialogTab>('conversation')
  const dialogWorkItemKey = githubTaskDrawerWorkItem
    ? { id: githubTaskDrawerWorkItem.id, repoId: githubTaskDrawerWorkItem.repoId }
    : null

  const appliedWorkItemsCacheQuery = useMemo(
    () => stripRepoQualifiers(appliedTaskSearch.trim()),
    [appliedTaskSearch]
  )
  const selectedWorkItemsCacheEntries = useAppStore(
    useShallow((s) =>
      selectTaskPageWorkItemsCacheEntries(
        s.workItemsCache,
        selectedRepos.map(getTaskPageRepoCacheInput),
        githubPerRepoPageLimit,
        appliedWorkItemsCacheQuery
      )
    )
  )

  // Why: derive the dialog item from the cache for optimistic patches, falling back to the click-time snapshot for new stubs; key by repoId so same-number issues across repos resolve to the clicked row.
  const cachedDialogWorkItem = useAppStore((s) =>
    findTaskPageDialogWorkItem(s.workItemsCache, dialogWorkItemKey)
  )
  const dialogWorkItem = dialogWorkItemKey
    ? (cachedDialogWorkItem ?? githubTaskDrawerWorkItem)
    : null

  useLayoutEffect(() => {
    const scrollTop = pendingGithubScrollRestoreRef.current
    const scrollElement = githubListScrollRef.current
    if (scrollTop === null || !scrollElement || !pages[currentPage]) {
      return
    }
    let frame: number | null = null
    let timeout: number | null = null
    let observer: ResizeObserver | null = null
    const clearScheduledRestore = (): void => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        frame = null
      }
      if (timeout !== null) {
        window.clearTimeout(timeout)
        timeout = null
      }
      observer?.disconnect()
    }
    const restore = (): void => {
      const committedScrollElement = githubListScrollRef.current
      if (!committedScrollElement || pendingGithubScrollRestoreRef.current !== scrollTop) {
        return
      }
      committedScrollElement.scrollTop = scrollTop
      githubListScrollTopRef.current = scrollTop
      taskListPositionRef.current = {
        contextKey: githubResumeContextKey,
        page: currentPage,
        scrollTop
      }
      if (Math.abs(committedScrollElement.scrollTop - scrollTop) < 1) {
        pendingGithubScrollRestoreRef.current = null
        clearScheduledRestore()
      }
    }
    observer = new ResizeObserver(restore)
    for (const child of scrollElement.children) {
      observer.observe(child)
    }
    restore()
    if (pendingGithubScrollRestoreRef.current === scrollTop) {
      frame = window.requestAnimationFrame(restore)
      timeout = window.setTimeout(() => {
        if (pendingGithubScrollRestoreRef.current === scrollTop) {
          const committedScrollTop = githubListScrollRef.current?.scrollTop ?? 0
          githubListScrollTopRef.current = committedScrollTop
          taskListPositionRef.current = {
            contextKey: githubResumeContextKey,
            page: currentPage,
            scrollTop: committedScrollTop
          }
          pendingGithubScrollRestoreRef.current = null
        }
        clearScheduledRestore()
      }, 5_000)
    }
    return clearScheduledRestore
  }, [
    currentPage,
    dialogWorkItem,
    githubResumeContextKey,
    pages,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef,
    githubListScrollRef.current?.scrollTop,
    githubListScrollRef
  ])

  const dialogRepoPath = dialogWorkItem ? (repoMap.get(dialogWorkItem.repoId)?.path ?? null) : null
  const dialogSourceContext = useMemo(() => {
    if (!dialogWorkItem) {
      return null
    }
    if (
      pageData.openGitHubSourceContext?.provider === 'github' &&
      pageData.openGitHubWorkItem?.id === dialogWorkItem.id &&
      pageData.openGitHubWorkItem.repoId === dialogWorkItem.repoId
    ) {
      return pageData.openGitHubSourceContext
    }
    return getTaskPageRepoSourceContext(repoMap.get(dialogWorkItem.repoId), 'github')
  }, [dialogWorkItem, pageData.openGitHubSourceContext, pageData.openGitHubWorkItem, repoMap])
  const gitlabDialogRepo = useMemo(
    () =>
      gitlabDialogItem
        ? (selectedRepos.find((r) => r.id === gitlabDialogItem.repoId) ?? primaryRepo)
        : null,
    [gitlabDialogItem, primaryRepo, selectedRepos]
  )
  const gitlabDialogSourceContext = useMemo(() => {
    if (!gitlabDialogItem) {
      return null
    }
    if (
      pageData.openGitLabSourceContext?.provider === 'gitlab' &&
      pageData.openGitLabWorkItem?.id === gitlabDialogItem.id &&
      pageData.openGitLabWorkItem?.repoId === gitlabDialogItem.repoId
    ) {
      return pageData.openGitLabSourceContext
    }
    return getTaskPageRepoSourceContext(gitlabDialogRepo, 'gitlab', gitlabDialogItem.projectRef)
  }, [
    gitlabDialogItem,
    gitlabDialogRepo,
    pageData.openGitLabSourceContext,
    pageData.openGitLabWorkItem
  ])

  const setDialogWorkItem = useCallback(
    (item: GitHubWorkItem | null, initialTab: ItemDialogTab = 'conversation') => {
      setDialogInitialTab(item ? initialTab : 'conversation')
      setGithubTaskDrawerWorkItem(item)
    },
    [setGithubTaskDrawerWorkItem]
  )

  useEffect(() => {
    if (!pageData.openGitHubWorkItem) {
      setDialogWorkItem(null)
      return
    }
    setGithubMode('items')
    setDialogWorkItem(pageData.openGitHubWorkItem, pageData.openGitHubInitialTab)
  }, [pageData.openGitHubInitialTab, pageData.openGitHubWorkItem, setDialogWorkItem])

  useEffect(() => {
    setGitlabDialogItem(pageData.openGitLabWorkItem ?? null)
  }, [pageData.openGitLabWorkItem, setGitlabDialogItem])

  const openGitHubDetailPage = useCallback(
    (item: GitHubWorkItem, initialTab: ItemDialogTab = 'conversation') => {
      const scrollTop = githubListScrollRef.current?.scrollTop ?? githubListScrollTopRef.current
      githubListScrollTopRef.current = scrollTop
      pendingGithubScrollRestoreRef.current = scrollTop
      taskListPositionRef.current = {
        contextKey: githubResumeContextKey,
        page: currentPageRef.current,
        scrollTop
      }
      useAppStore.getState().setTaskListPosition(taskListPositionRef.current)
      openTaskPage(
        {
          taskSource: 'github',
          preselectedRepoId: item.repoId,
          openGitHubWorkItem: item,
          openGitHubSourceContext: getTaskPageRepoSourceContext(repoMap.get(item.repoId), 'github'),
          openGitHubInitialTab: initialTab
        },
        { recordTasksInteraction: false }
      )
    },
    [
      githubResumeContextKey,
      openTaskPage,
      repoMap,
      githubListScrollTopRef,
      pendingGithubScrollRestoreRef,
      currentPageRef,
      githubListScrollRef.current?.scrollTop
    ]
  )

  const openGitLabDetailPage = useCallback(
    (item: GitLabWorkItem) => {
      openTaskPage(
        {
          taskSource: 'gitlab',
          preselectedRepoId: item.repoId,
          openGitLabWorkItem: item,
          openGitLabSourceContext: getTaskPageRepoSourceContext(
            repoMap.get(item.repoId),
            'gitlab',
            item.projectRef
          )
        },
        { recordTasksInteraction: false }
      )
    },
    [openTaskPage, repoMap]
  )

  const patchTaskPageWorkItemRows = useCallback(
    (
      itemKey: { id: string; repoId: string },
      patch: Partial<GitHubWorkItem>,
      shouldPatch?: (item: GitHubWorkItem) => boolean
    ): void => {
      setPages((current) => {
        return patchTaskPageGitHubWorkItemPages(current, itemKey, patch, shouldPatch)
      })
    },
    [setPages]
  )
  const handleDialogReviewRequestsChange = useCallback(
    (itemKey: { id: string; repoId: string }, reviewRequests: GitHubAssignableUser[]): void => {
      patchTaskPageWorkItemRows(itemKey, { reviewRequests })
    },
    [patchTaskPageWorkItemRows]
  )

  // Why: the per-repo issue-source indicator and retry banner both derive from the same workItemsCache entry, so no extra IPC.
  // Why: subscribe only to entries this page renders; the selector returns entry refs so shallow equality filters unrelated cache writes.
  const perRepoSourceState = useMemo<TaskPageRepoSourceState[]>(
    () => buildTaskPageRepoSourceState(selectedRepos, selectedWorkItemsCacheEntries),
    [selectedRepos, selectedWorkItemsCacheEntries]
  )

  // Why: repos that fetched but resolved no GitHub source (#9660) show empty like a genuine zero-result; surface them explicitly with Retry.
  const unresolvedSourceRepos = useMemo(
    () => selectTaskPageUnresolvedSourceRepos(selectedRepos, perRepoSourceState),
    [selectedRepos, perRepoSourceState]
  )

  useEffect(() => {
    if (taskSource !== 'github' || githubMode !== 'items') {
      return
    }
    // Why: inline/dialog edits patch `workItemsCache`; the paged table renders
    // from a local snapshot so it needs the patched row objects copied across.
    // Hard guarantee (K4): always overlay pending after reconcile so list
    // fetch clobbers never paint unprotected coordinator fields.
    setPages((current) =>
      reconcileTaskPagePagesWithWorkItemsCache(current, selectedWorkItemsCacheEntries).map((page) =>
        page ? (overlayPendingOnTaskPagePages([page])[0] ?? []) : null
      )
    )
  }, [githubMode, selectedWorkItemsCacheEntries, taskSource, setPages])

  // Why: one-time toast per repo when the 'upstream' preference fell back to origin (ref-gated); deliberately don't auto-reset the preference so re-adding upstream later still applies.
  const fellBackToastedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (taskSource !== 'github') {
      return
    }
    for (const [index, r] of selectedRepos.entries()) {
      const entry = selectedWorkItemsCacheEntries[index]
      if (!entry?.issueSourceFellBack) {
        continue
      }
      if (fellBackToastedRef.current.has(r.id)) {
        continue
      }
      const prSlug = entry.sources?.prs
        ? `${entry.sources.prs.owner}/${entry.sources.prs.repo}`
        : r.displayName
      toast.message(
        translate(
          'auto.components.TaskPage.f4374519ae',
          'Your preferred issue source (upstream) is no longer configured for {{value0}}. Using origin.',
          { value0: prSlug }
        )
      )
      fellBackToastedRef.current.add(r.id)
    }
  }, [selectedRepos, selectedWorkItemsCacheEntries, taskSource])

  // Why: partial-failure retry leaves the cache populated so tasksLoading never flips, giving no feedback; track retry-in-flight per source so only the clicked banner shows "Retrying…".
  const [retryingSourceKeys, setRetryingSourceKeys] = useState<ReadonlySet<string>>(() => new Set())

  const handleRetryIssuesFetch = useCallback(
    (sourceKey: string) => {
      const source = perRepoSourceState.find((s) => s.sourceKey === sourceKey)
      if (!source) {
        return
      }
      // Why: nonce bump reuses the fetch path as force=true so retry doesn't dedupe onto a still-failing in-flight request (refreshes all repos; Retrying… stays scoped to the clicked source).
      setRetryingSourceKeys((prev) => {
        const next = new Set(prev)
        next.add(source.sourceKey)
        return next
      })
      setTaskRefreshNonce((n) => n + 1)
    },
    [perRepoSourceState, setTaskRefreshNonce]
  )
  const handleRefreshGithubTasks = useCallback((): void => {
    setTasksRefreshing(true)
    setTaskRefreshNonce((current) => current + 1)
  }, [setTasksRefreshing, setTaskRefreshNonce])
  const {
    newIssueOpen,
    setNewIssueOpen,
    newIssueTitle,
    setNewIssueTitle,
    newIssueBody,
    setNewIssueBody,
    newIssueLabels,
    setNewIssueLabels,
    newIssueAssignees,
    setNewIssueAssignees,
    newIssueSubmitting,
    setNewIssueSubmitting,
    newIssueRepoId,
    setNewIssueRepoId,
    setNewIssueDraft,
    clearNewIssueDraft,
    newIssueTargetRepo,
    newIssueSourceContext,
    newIssueRuntimeTarget,
    newIssueRepoLabels,
    newIssueRepoAssignees
  } = useTaskPageGitHubNewIssueState({
    selectedRepos,
    settings,
    repos
  })

  const {
    selectedLinearIssueId,
    setSelectedLinearIssueFallback,
    selectedLinearIssueCanFloat,
    linearCacheSnapshot,
    jiraCacheSnapshot,
    selectedLinearIssue,
    linearDetailSourceContext,
    setSelectedLinearIssue,
    clearSelectedLinearIssue,
    openLinearDetailPage,
    openRelatedLinearIssue,
    closeTaskDetailPage,
    selectedJiraIssueKey,
    setSelectedJiraIssueKey,
    selectedJiraIssueFallback,
    setSelectedJiraIssueFallback,
    selectedJiraIssue,
    jiraDetailSourceContext,
    setSelectedJiraIssue,
    openJiraDetailPage
  } = useTaskPageSelectedIssueState({
    pageData,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    openTaskPage,
    setDialogWorkItem
  })

  const {
    linearMode,
    setLinearMode,
    linearIssues,
    setLinearIssues,
    linearIssueLimit,
    setLinearIssueLimit,
    linearIssuePage,
    setLinearIssuePage,
    linearIssueLoadingTargetPage,
    setLinearIssueLoadingTargetPage,
    linearIssuesHasMore,
    setLinearIssuesHasMore,
    linearLoading,
    setLinearLoading,
    linearError,
    setLinearError,
    linearSearchInput,
    setLinearSearchInput,
    appliedLinearSearch,
    setAppliedLinearSearch,
    linearIssueFiltersByWorkspaceId,
    setLinearIssueFiltersByWorkspaceId,
    linearAttributeFilterWorkspaceId,
    linearAttributeFilter,
    linearAttributeFilterReadRef,
    linearPrimaryTeamRef,
    linearViewMode,
    setLinearViewMode,
    linearGroupBy,
    setLinearGroupBy,
    linearOrderBy,
    setLinearOrderBy,
    linearDisplayProperties,
    setLinearDisplayProperties,
    linearTeamPropertyTouched,
    setLinearTeamPropertyTouched,
    linearRefreshNonce,
    setLinearRefreshNonce,
    linearProjectSearchInput,
    setLinearProjectSearchInput,
    appliedLinearProjectSearch,
    setAppliedLinearProjectSearch,
    linearProjectsResult,
    setLinearProjectsResult,
    linearProjectsLoading,
    setLinearProjectsLoading,
    linearProjectsError,
    setLinearProjectsError,
    selectedLinearProject,
    setSelectedLinearProject,
    selectedLinearProjectDetail,
    setSelectedLinearProjectDetail,
    linearProjectDetailLoading,
    setLinearProjectDetailLoading,
    linearProjectDetailError,
    setLinearProjectDetailError,
    linearProjectTab,
    setLinearProjectTab,
    linearProjectIssuesResult,
    setLinearProjectIssuesResult,
    linearProjectIssueLimit,
    setLinearProjectIssueLimit,
    linearProjectIssuePage,
    setLinearProjectIssuePage,
    linearProjectIssueLoadingTargetPage,
    setLinearProjectIssueLoadingTargetPage,
    linearProjectIssuesLoading,
    setLinearProjectIssuesLoading,
    linearProjectIssuesError,
    setLinearProjectIssuesError,
    linearCustomViewsResult,
    setLinearCustomViewsResult,
    linearCustomViewsLoading,
    setLinearCustomViewsLoading,
    linearCustomViewsError,
    setLinearCustomViewsError,
    selectedLinearCustomView,
    setSelectedLinearCustomView,
    linearProjectParentView,
    setLinearProjectParentView,
    linearCustomViewIssuesResult,
    setLinearCustomViewIssuesResult,
    linearCustomViewIssueLimit,
    setLinearCustomViewIssueLimit,
    linearCustomViewIssuePage,
    setLinearCustomViewIssuePage,
    linearCustomViewIssueLoadingTargetPage,
    setLinearCustomViewIssueLoadingTargetPage,
    linearCustomViewProjectsResult,
    setLinearCustomViewProjectsResult,
    linearCustomViewContentsLoading,
    setLinearCustomViewContentsLoading,
    linearCustomViewContentsError,
    setLinearCustomViewContentsError,
    openLinearProjectContext,
    openLinearCustomViewContext,
    linearBoardDraggingIssueId,
    setLinearBoardDraggingIssueId,
    linearBoardDragOverKey,
    setLinearBoardDragOverKey,
    linearBoardUpdatingIssueIds,
    setLinearBoardUpdatingIssueIds,
    lastLinearRequestRef,
    landingLinearRefreshKeysRef,
    linearContextResumeAttemptedRef,
    patchScopedLinearIssue,
    selectLinearMode
  } = useTaskPageLinearListState({
    selectedLinearWorkspaceId,
    clearSelectedLinearIssue,
    setTaskResumeState
  })

  const {
    jiraIssues,
    setJiraIssues,
    jiraLoading,
    setJiraLoading,
    jiraError,
    setJiraError,
    jiraErrorDetailsOpen,
    setJiraErrorDetailsOpen,
    jiraSearchInput,
    setJiraSearchInput,
    appliedJiraSearch,
    setAppliedJiraSearch,
    activeJiraPreset,
    setActiveJiraPreset,
    jiraRefreshNonce,
    setJiraRefreshNonce,
    jiraProjectStatusOrder,
    setJiraProjectStatusOrder,
    jiraOrderBy,
    jiraOrderDirection,
    jiraPrioritiesBySite,
    handleJiraSort
  } = useTaskPageJiraListState({
    selectedJiraSiteId,
    taskSource,
    jiraConnected,
    jiraTaskSourceContext,
    settings
  })

  useTaskPageSessionResume({
    persistedUIReady,
    settings,
    pageData,
    resolvedInitialSelection,
    taskResumeState,
    visibleTaskProviders,
    setTaskSource,
    setRepoSelection,
    setGithubMode,
    setTaskSearchInput,
    setAppliedTaskSearch,
    setActiveTaskPreset,
    setLinearMode,
    setLinearSearchInput,
    setAppliedLinearSearch,
    setLinearViewMode,
    setLinearGroupBy,
    setLinearOrderBy,
    setLinearDisplayProperties,
    setLinearTeamPropertyTouched,
    setLinearIssueFiltersByWorkspaceId,
    setActiveJiraPreset,
    setJiraSearchInput,
    setAppliedJiraSearch,
    taskResumeAppliedRef,
    setTaskResumeApplied,
    linearContextResumeAttemptedRef,
    taskResumeApplied,
    taskSource,
    linearConnected,
    fetchLinearProject,
    fetchLinearCustomView,
    listLinearCustomViews,
    linearTaskSourceContext,
    setTaskResumeState,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setLinearProjectParentView,
    setLinearProjectsError,
    setLinearCustomViewsLoading,
    setLinearCustomViewsError,
    setSelectedLinearCustomView
  })

  const { availableTeams, setAvailableTeams, setLinearTeamRefreshNonce } = useTaskPageLinearTeams({
    taskResumeApplied,
    taskSource,
    linearConnected,
    selectedLinearWorkspaceId,
    getCachedLinearTeams,
    linearTaskSourceContext,
    listLinearTeams
  })

  const { availableJiraProjects, jiraProjectsLoading } = useTaskPageJiraProjects({
    taskResumeApplied,
    taskSource,
    jiraConnected,
    jiraTaskSourceContext,
    settings,
    selectedJiraSiteId
  })

  useTaskPageGitLabFetch({
    taskSource,
    gitlabView,
    activeGitlabFilter,
    gitlabRefreshNonce,
    selectedRepos,
    selectedReposKey,
    primaryRepo,
    setGitlabItems,
    setGitlabLoading,
    setGitlabError,
    setGitlabTodos,
    setGitlabTodosLoading
  })

  const {
    defaultLinearTeamSelection,
    linearTeamSelection,
    setLinearTeamSelection,
    activeLinearIssues,
    activeLinearIssueLoading,
    activeLinearIssueError,
    activeLinearIssueHasCollectionError,
    activeLinearIssueContextLabel,
    activeLinearIssuePage,
    activeLinearIssueLoadingTargetPage,
    activeLinearIssueCanRequestMore,
    activeLinearIssueLimit
  } = useTaskPageLinearActiveCollection({
    settings,
    selectedLinearProject,
    linearProjectTab,
    linearProjectIssuesResult,
    selectedLinearCustomView,
    linearCustomViewIssuesResult,
    linearIssues,
    linearProjectIssuesLoading,
    linearCustomViewContentsLoading,
    linearLoading,
    linearStatus,
    linearProjectIssuesError,
    linearCustomViewContentsError,
    linearError,
    appliedLinearSearch,
    linearIssuesHasMore,
    linearIssueLimit,
    linearProjectIssueLimit,
    linearCustomViewIssueLimit,
    linearProjectIssuePage,
    linearCustomViewIssuePage,
    linearIssuePage,
    linearProjectIssueLoadingTargetPage,
    linearCustomViewIssueLoadingTargetPage,
    linearIssueLoadingTargetPage
  })

  const {
    linearTeamOptions,
    linearAttributePrimaryTeam,
    applyLinearAttributeFilter,
    linearSearchActive,
    showLinearAttributeFilters,
    linearIssueAttachmentIndex,
    inOrcaLinkedLinearRefsSignature,
    inOrcaLinkedLinearRefsRef,
    filteredLinearIssues,
    linearIssueTotalPages,
    visibleLinearIssuePage,
    pagedLinearIssues,
    showLinearIssuePagination,
    handleLinearIssuePageChange,
    showLinearEmptyFilteredLoadMore,
    handleLinearEmptyFilteredLoadMore
  } = useTaskPageLinearIssueWindow({
    activeLinearIssues,
    linearCacheSnapshot,
    availableTeams,
    defaultLinearTeamSelection,
    linearTeamSelection,
    setLinearTeamSelection,
    linearAttributeFilterWorkspaceId,
    setLinearIssueFiltersByWorkspaceId,
    setLinearIssueLimit,
    setLinearIssuePage,
    setLinearIssueLoadingTargetPage,
    linearPrimaryTeamRef,
    linearAttributeFilter,
    linearSearchInput,
    appliedLinearSearch,
    linearMode,
    activeLinearIssueContextLabel,
    allWorktrees,
    folderWorkspaces,
    selectedLinearWorkspaceId,
    linearStatus,
    linearOrderBy,
    activeLinearIssueCanRequestMore,
    activeLinearIssuePage,
    activeLinearIssueError,
    activeLinearIssueLoading,
    selectedLinearProject,
    linearProjectTab,
    selectedLinearCustomView,
    setLinearProjectIssuePage,
    setLinearCustomViewIssuePage,
    setLinearProjectIssueLoadingTargetPage,
    setLinearCustomViewIssueLoadingTargetPage,
    setLinearProjectIssueLimit,
    setLinearCustomViewIssueLimit,
    activeLinearIssueLimit,
    activeLinearIssueLoadingTargetPage,
    activeLinearIssueHasCollectionError
  })

  const {
    selectedLinearTeamForExternalLink,
    effectiveLinearDisplayProperties,
    linearIssueGridStyle,
    linearIssueListRows,
    linearBoardSections,
    linearStatusBoardEnabled,
    handleLinearBoardCardDragStart,
    handleLinearBoardDragOver,
    handleLinearBoardDrop,
    toggleLinearDisplayProperty
  } = useTaskPageLinearBoard({
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
  })

  const { displayedJiraIssues, displayedJiraStatusOrder, sortedJiraIssues } =
    useTaskPageJiraDisplayedIssues({
      jiraIssues,
      jiraIssueCache: jiraCacheSnapshot.issueCache,
      jiraSearchCache: jiraCacheSnapshot.searchCache,
      jiraTaskSourceContext,
      jiraTaskSourceScopeKey,
      jiraProjectStatusOrder,
      jiraOrderBy,
      jiraOrderDirection,
      jiraPrioritiesBySite
    })

  const {
    newLinearProjectOpen,
    setNewLinearProjectOpen,
    newLinearProjectName,
    setNewLinearProjectName,
    newLinearProjectDescription,
    setNewLinearProjectDescription,
    newLinearProjectContent,
    setNewLinearProjectContent,
    setNewLinearProjectTeamId,
    newLinearProjectLeadId,
    setNewLinearProjectLeadId,
    newLinearProjectMemberIds,
    setNewLinearProjectMemberIds,
    newLinearProjectLabelIds,
    setNewLinearProjectLabelIds,
    newLinearProjectPriority,
    setNewLinearProjectPriority,
    newLinearProjectStartDate,
    setNewLinearProjectStartDate,
    newLinearProjectTargetDate,
    setNewLinearProjectTargetDate,
    newLinearProjectSubmitting,
    setNewLinearProjectSubmitting,
    newLinearProjectTargetTeam,
    newLinearProjectMembers,
    newLinearProjectLabels,
    discardNewLinearProjectDraft,
    newLinearIssueOpen,
    setNewLinearIssueOpen,
    newLinearIssueTitle,
    setNewLinearIssueTitle,
    newLinearIssueBody,
    setNewLinearIssueBody,
    newLinearIssueTeamId,
    setNewLinearIssueTeamId,
    newLinearIssueSubmitting,
    setNewLinearIssueSubmitting,
    newLinearIssueStateId,
    setNewLinearIssueStateId,
    newLinearIssueAssigneeId,
    setNewLinearIssueAssigneeId,
    newLinearIssuePriority,
    setNewLinearIssuePriority,
    newLinearIssueProjectId,
    setNewLinearIssueProjectId,
    newLinearIssueLabelIds,
    setNewLinearIssueLabelIds,
    discardNewLinearIssueDraft,
    newLinearIssueTargetTeam,
    newLinearIssueProjects,
    setNewLinearIssueProjects,
    newLinearIssueProjectsLoading,
    setNewLinearIssueProjectsLoading,
    newLinearStates,
    newLinearMembers,
    newLinearLabels,
    linearConnectOpen,
    setLinearConnectOpen
  } = useTaskPageLinearCreateDialogs({
    availableTeams,
    settings,
    linearConnected,
    selectedLinearWorkspaceId,
    linearTaskSourceContext,
    selectedLinearProject
  })

  const [jiraConnectOpen, setJiraConnectOpen] = useState(false)
  useContextualTour(
    'tasks',
    !dialogWorkItem &&
      !gitlabDialogItem &&
      !selectedLinearIssue &&
      !newIssueOpen &&
      !newLinearProjectOpen &&
      !newLinearIssueOpen &&
      !linearConnectOpen &&
      !jiraConnectOpen &&
      activeModal === 'none',
    'tasks_open'
  )

  const activeGithubTaskKind = getGitHubTaskKind(activeTaskPreset, appliedTaskSearch)
  const appliedTaskQuery = useMemo(() => parseTaskQuery(appliedTaskSearch), [appliedTaskSearch])

  const { githubWorkItemMutationQueryKey, githubWorkItemMutation, selectedGitHubRepoExternalLink } =
    useTaskPageGitHubMutationSession({
      selectedRepos,
      githubMode,
      appliedTaskSearch,
      appliedTaskQuery,
      githubViewerLogin,
      setGitHubViewerLogin,
      patchTaskPageWorkItemRows,
      pages,
      taskSource,
      perRepoSourceState,
      activeGithubTaskKind,
      setQuietRefreshNonce
    })

  const {
    newJiraIssueOpen,
    setNewJiraIssueOpen,
    newJiraIssueTitle,
    setNewJiraIssueTitle,
    newJiraIssueBody,
    setNewJiraIssueBody,
    setNewJiraIssueProjectId,
    newJiraIssueProjectComboboxOpen,
    setNewJiraIssueProjectComboboxOpen,
    newJiraIssueProjectQuery,
    setNewJiraIssueProjectQuery,
    newJiraIssueProjectCommandValue,
    setNewJiraIssueProjectCommandValue,
    newJiraIssueTypeId,
    setNewJiraIssueTypeId,
    newJiraIssueSubmitting,
    setNewJiraIssueSubmitting,
    newJiraIssueProjectSearchInputRef,
    availableJiraIssueTypes,
    setAvailableJiraIssueTypes,
    jiraIssueTypesLoading,
    setJiraIssueTypesLoading,
    setJiraCreateFields,
    jiraCreateFieldsLoading,
    setJiraCreateFieldsLoading,
    jiraCreateFieldsError,
    setJiraCreateFieldsError,
    newJiraIssueCustomFieldValues,
    setNewJiraIssueCustomFieldValues,
    discardNewJiraIssueDraft,
    includeJiraSiteNameInProjectLabel,
    sortedAvailableJiraProjects,
    filteredNewJiraIssueProjects,
    newJiraIssueTargetProject,
    newJiraIssueTargetProjectSelectionKey,
    newJiraIssueTargetType,
    visibleJiraCreateFields,
    hasMissingJiraCreateField,
    handleNewJiraIssueProjectComboboxOpenChange,
    handleNewJiraIssueProjectSelect,
    handleNewJiraIssueProjectTriggerKeyDown
  } = useTaskPageJiraCreateDialog({
    selectedJiraSiteId,
    availableJiraProjects,
    jiraConnected,
    settings,
    jiraTaskSourceContext
  })
  useTaskPageCreateDialogResets({
    providerRuntimeContextKey,
    setNewLinearIssueOpen,
    setNewLinearIssueTitle,
    setNewLinearIssueBody,
    setNewLinearIssueTeamId,
    setNewLinearIssueStateId,
    setNewLinearIssueAssigneeId,
    setNewLinearIssuePriority,
    setNewLinearIssueProjectId,
    setNewLinearIssueLabelIds,
    setNewLinearIssueProjects,
    setNewLinearIssueProjectsLoading,
    setNewLinearIssueSubmitting,
    setNewJiraIssueOpen,
    setNewJiraIssueTitle,
    setNewJiraIssueBody,
    setNewJiraIssueProjectId,
    setNewJiraIssueProjectComboboxOpen,
    setNewJiraIssueProjectQuery,
    setNewJiraIssueProjectCommandValue,
    setNewJiraIssueTypeId,
    setAvailableJiraIssueTypes,
    setJiraIssueTypesLoading,
    setJiraCreateFields,
    setJiraCreateFieldsLoading,
    setJiraCreateFieldsError,
    setNewJiraIssueCustomFieldValues,
    setNewJiraIssueSubmitting
  })

  const {
    filteredWorkItems,
    softHiddenVisibleCount,
    showGitHubTaskSkeletons,
    loadedGitHubAuthorLogins,
    primaryGithubFilterSlug,
    showPRManagementColumns,
    githubTaskGridClass,
    ensurePRChecksLoaded,
    totalPages
  } = useTaskPageGitHubFilteredItems({
    activeGithubTaskKind,
    pages,
    currentPage,
    githubWorkItemMutation,
    tasksFiltering,
    tasksLoading,
    perRepoSourceState,
    repoMap,
    fetchPRChecks,
    patchTaskPageWorkItemRows,
    taskSource,
    githubMode,
    githubPageSize,
    countedTotalPages,
    provenPageLimit
  })

  const { handleLoadNextPage } = useTaskPageGitHubPageLoader({
    paginationLoading,
    selectedRepos,
    appliedTaskSearch,
    paginationGenerationRef,
    currentPage,
    setPaginationLoading,
    setLoadingTargetPage,
    fetchWorkItemsNextPage,
    githubPerRepoPageLimit,
    githubPageSize,
    countedTotalPagesRef,
    setProvenPageLimit,
    setCountedTotalPages,
    pagesRef,
    currentPageRef,
    setPages,
    setCurrentPage
  })

  const commitTaskSearch = useCallback(
    (value: string): void => {
      const scoped = scopeGitHubTaskSearch(value, activeGithubTaskKind)
      if (scoped !== appliedTaskSearch) {
        setTasksFiltering(true)
      }
      setAppliedTaskSearch(scoped)
    },
    [activeGithubTaskKind, appliedTaskSearch, setAppliedTaskSearch, setTasksFiltering]
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

  useTaskPageGitHubFetch({
    taskResumeApplied,
    taskSource,
    githubMode,
    selectedRepos,
    setRetryingSourceKeys,
    setTasksRefreshing,
    setTasksFiltering,
    appliedTaskSearch,
    githubResumeContextRef,
    githubResumeContextKey,
    githubResumeConsumedRef,
    currentPageRef,
    pagesRef,
    pendingGithubScrollRestoreRef,
    getCachedWorkItems,
    githubPerRepoPageLimit,
    githubPageSize,
    githubWorkItemMutationQueryKey,
    setPages,
    setCurrentPage,
    setCountedTotalPages,
    countedTotalPagesRef,
    setProvenPageLimit,
    setTasksError,
    setFailedCount,
    setGithubUnavailable,
    setTasksLoading,
    taskRefreshNonce,
    lastFetchedNonceRef,
    workItemsInvalidationNonce,
    lastFetchedInvalidationNonceRef,
    hardRefreshEpochRef,
    landingGitHubRefreshKeysRef,
    paginationGenerationRef,
    setPaginationLoading,
    setLoadingTargetPage,
    fetchWorkItemsNextPage,
    fetchWorkItemsAcrossRepos,
    countWorkItemsAcrossRepos,
    retryingSourceKeys,
    selectedReposKey
  })

  useTaskPageGitHubQuietRevalidate({
    githubWorkItemMutationQueryKey,
    quietRefreshNonce,
    taskSource,
    githubMode,
    selectedRepos,
    pagesRef,
    pages,
    currentPage,
    currentPageRef,
    appliedTaskSearch,
    hardRefreshEpochRef,
    fetchWorkItemsAcrossRepos,
    fetchWorkItemsNextPage,
    githubPerRepoPageLimit,
    githubPageSize,
    setPages,
    setQuietRefreshNonce
  })

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
      setTaskSearchInput,
      setActiveTaskPreset,
      setTasksFiltering,
      setAppliedTaskSearch,
      setTaskRefreshNonce
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
    setTaskRefreshNonce,
    setTaskSearchInput,
    setActiveTaskPreset,
    setTasksFiltering
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
      setAppliedTaskSearch,
      setTaskRefreshNonce,
      setTaskSearchInput,
      setActiveTaskPreset,
      setTasksFiltering
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

  const { handleUseWorkItem, handleOpenOrUseGitHubWorkItem, handleUseGitLabItem } =
    useTaskPageUseItemActions({
      openModal,
      repoMap
    })

  const { handleCreateNewIssue } = useTaskPageCreateGithubSubmit({
    newIssueTargetRepo,
    newIssueTitle,
    newIssueSubmitting,
    newIssueRuntimeTarget,
    newIssueSourceContext,
    newIssueBody,
    newIssueLabels,
    newIssueAssignees,
    setNewIssueSubmitting,
    setNewIssueOpen,
    setNewIssueTitle,
    setNewIssueDraft,
    setNewIssueBody,
    setNewIssueLabels,
    setNewIssueAssignees,
    clearNewIssueDraft,
    setTaskRefreshNonce,
    openGitHubDetailPage,
    setDialogWorkItem
  })

  const { handleCreateNewLinearProject, handleCreateNewLinearIssue } =
    useTaskPageCreateLinearSubmits({
      newLinearProjectTargetTeam,
      newLinearProjectName,
      newLinearProjectSubmitting,
      linearTaskSourceContext,
      settings,
      newLinearProjectDescription,
      newLinearProjectContent,
      newLinearProjectLeadId,
      newLinearProjectMemberIds,
      newLinearProjectLabelIds,
      newLinearProjectPriority,
      newLinearProjectStartDate,
      newLinearProjectTargetDate,
      discardNewLinearProjectDraft,
      setNewLinearProjectSubmitting,
      setNewLinearProjectOpen,
      setNewLinearProjectName,
      setNewLinearProjectDescription,
      setNewLinearProjectContent,
      setNewLinearProjectLeadId,
      setNewLinearProjectMemberIds,
      setNewLinearProjectLabelIds,
      setNewLinearProjectPriority,
      setNewLinearProjectStartDate,
      setNewLinearProjectTargetDate,
      setAppliedLinearProjectSearch,
      setLinearProjectSearchInput,
      setLinearProjectsResult,
      setSelectedLinearProjectDetail,
      openLinearProjectContext,
      setLinearRefreshNonce,
      newLinearIssueTargetTeam,
      newLinearIssueTitle,
      newLinearIssueSubmitting,
      selectedLinearProject,
      newLinearIssueProjectId,
      providerRuntimeContextKey,
      providerRuntimeContextKeyRef,
      newLinearIssueBody,
      newLinearIssueStateId,
      newLinearIssuePriority,
      newLinearIssueAssigneeId,
      newLinearIssueLabelIds,
      discardNewLinearIssueDraft,
      setNewLinearIssueSubmitting,
      setNewLinearIssueOpen,
      setNewLinearIssueTitle,
      setNewLinearIssueBody,
      setNewLinearIssueStateId,
      setNewLinearIssueAssigneeId,
      setNewLinearIssuePriority,
      setNewLinearIssueProjectId,
      setNewLinearIssueLabelIds,
      setSelectedLinearIssue
    })

  const { handleCreateNewJiraIssue } = useTaskPageCreateJiraSubmit({
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    newJiraIssueTitle,
    newJiraIssueSubmitting,
    hasMissingJiraCreateField,
    jiraCreateFieldsLoading,
    visibleJiraCreateFields,
    newJiraIssueCustomFieldValues,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    jiraTaskSourceContext,
    settings,
    newJiraIssueBody,
    discardNewJiraIssueDraft,
    setNewJiraIssueSubmitting,
    setNewJiraIssueOpen,
    setNewJiraIssueTitle,
    setNewJiraIssueBody,
    setNewJiraIssueCustomFieldValues,
    setJiraRefreshNonce,
    setJiraIssues,
    setSelectedJiraIssue
  })

  const githubTasksBusy = tasksLoading || tasksRefreshing || tasksFiltering

  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (
      dialogWorkItem ||
      selectedJiraIssue ||
      selectedLinearIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
      activeModal !== 'none'
    ) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      // Why: open menus/popovers/selects own Esc; capture-phase leave would steal it from Radix.
      if (
        document.querySelector(
          '[data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="select-content"], [role="menu"]'
        )
      ) {
        return
      }

      // Why: Esc first blurs a focused input so it doesn't accidentally close the whole page; only closes once focus is outside an input.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }

      event.preventDefault()
      closeTaskPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeModal,
    closeTaskPage,
    dialogWorkItem,
    newIssueOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    selectedLinearIssue,
    selectedJiraIssue
  ])

  useEffect(() => {
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusReady) {
      void checkLinearConnection()
    }
    if (!jiraStatusReady) {
      void checkJiraConnection()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    expectedPreflightContextKey,
    jiraStatusContextKey,
    jiraStatusReady,
    linearStatusContextKey,
    linearStatusReady,
    providerRuntimeContextKey,
    preflightStatusContextKey,
    preflightStatusChecked,
    preflightStatusCurrent,
    refreshPreflightStatus
  ])

  // Why: debounce the Linear search input so we don't fire a request per keystroke (300ms, matching GitHub search).
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedLinearSearch(linearSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [linearSearchInput, taskResumeApplied, setAppliedLinearSearch])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!linearSearchPersistReadyRef.current) {
      linearSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({ linearQuery: appliedLinearSearch.trim() })
  }, [appliedLinearSearch, setTaskResumeState, taskResumeApplied, linearSearchPersistReadyRef])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!linearViewPersistReadyRef.current) {
      linearViewPersistReadyRef.current = true
      return
    }
    saveLinearIssueView(
      serializeLinearIssueViewResumeState({
        viewMode: linearViewMode,
        groupBy: linearGroupBy,
        orderBy: linearOrderBy,
        displayProperties: linearDisplayProperties,
        teamPropertyTouched: linearTeamPropertyTouched,
        filtersByWorkspaceId: linearIssueFiltersByWorkspaceId
      })
    )
  }, [
    linearDisplayProperties,
    linearGroupBy,
    linearIssueFiltersByWorkspaceId,
    linearOrderBy,
    linearTeamPropertyTouched,
    linearViewMode,
    taskResumeApplied,

    linearViewPersistReadyRef
  ])

  useEffect(() => {
    setLinearIssueLimit(LINEAR_ITEM_LIMIT)
    setLinearIssuePage(0)
    setLinearIssueLoadingTargetPage(null)
  }, [
    appliedLinearSearch,
    linearMode,
    selectedLinearCustomView?.id,
    selectedLinearProject?.id,
    selectedLinearWorkspaceId,
    taskSource,
    setLinearIssueLoadingTargetPage,
    setLinearIssueLimit,
    setLinearIssuePage
  ])

  useTaskPageLinearFetch({
    taskResumeApplied,
    taskSource,
    linearMode,
    linearConnected,
    appliedLinearSearch,
    linearIssueLimit,
    linearAttributeFilter,
    selectedLinearWorkspaceId,
    getCachedLinearIssues,
    linearTaskSourceContext,
    linearAttributeFilterWorkspaceId,
    linearAttributeFilterReadRef,
    lastLinearRequestRef,
    landingLinearRefreshKeysRef,
    linearRefreshNonce,
    searchLinearIssues,
    listLinearIssues,
    setLinearError,
    setLinearIssuesHasMore,
    setLinearIssues,
    setLinearLoading,
    linearListInvalidationVersionForSource
  })

  // Why: Has Worktree loads Linear tickets linked on local worktrees, not a Linear list/search query.
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || linearMode !== 'in-orca' || !linearConnected) {
      return
    }

    let cancelled = false
    const linkedRefs = inOrcaLinkedLinearRefsRef.current
    const requestSignature = `in-orca::${selectedLinearWorkspaceId ?? 'default'}::${inOrcaLinkedLinearRefsSignature}`
    const previousRequest = lastLinearRequestRef.current
    const isNewSignature = previousRequest?.signature !== requestSignature
    const forceRefresh = linearRefreshNonce > 0 && previousRequest?.nonce !== linearRefreshNonce
    lastLinearRequestRef.current = { nonce: linearRefreshNonce, signature: requestSignature }
    setLinearIssuesHasMore(false)
    setLinearError(null)

    if (linkedRefs.length === 0) {
      setLinearIssues([])
      setLinearLoading(false)
      return () => {
        cancelled = true
      }
    }

    if (isNewSignature) {
      setLinearIssues([])
    }
    setLinearLoading(true)
    // Why: fetchLinearIssue serves anything under the 60s TTL and ignores `force`, so an
    // explicit refresh has to go through refreshLinearIssue or the button does nothing.
    void readLinkedLinearIssuesWithLimit(linkedRefs, (ref) => {
      const read = forceRefresh ? refreshLinearIssue : fetchLinearIssue
      return read(ref.identifier, ref.workspaceId ?? selectedLinearWorkspaceId, {
        sourceContext: ref.sourceContext ?? linearTaskSourceContext
      })
    })
      .then((results) => {
        if (
          cancelled ||
          lastLinearRequestRef.current?.signature !== requestSignature ||
          lastLinearRequestRef.current?.nonce !== linearRefreshNonce
        ) {
          return
        }
        const loaded = results.filter((issue): issue is LinearIssue => issue != null)
        // Why: reads resolve to null instead of throwing, so an all-null result with links
        // present is a load failure — not the "nothing linked yet" empty state.
        if (loaded.length === 0) {
          setLinearError(
            translate(
              'auto.components.TaskPage.linearHasWorktreeLoadFailed',
              'Unable to load Linear issues linked to an Orca workspace.'
            )
          )
          setLinearIssues([])
          setLinearLoading(false)
          return
        }
        if (loaded.length !== results.length) {
          setLinearError(
            translate(
              'auto.components.TaskPage.linearHasWorktreePartialLoadFailed',
              'Some Linear issues linked to an Orca workspace could not be loaded. Refresh to try again.'
            )
          )
        }
        setLinearIssues(filterLinearIssuesForInOrcaWorkspace(loaded, selectedLinearWorkspaceId))
        setLinearLoading(false)
      })
      .catch((err) => {
        if (
          cancelled ||
          lastLinearRequestRef.current?.signature !== requestSignature ||
          lastLinearRequestRef.current?.nonce !== linearRefreshNonce
        ) {
          return
        }
        setLinearError(err instanceof Error ? err.message : 'Failed to load Linear issues.')
        setLinearLoading(false)
      })

    return () => {
      cancelled = true
    }
    // Why: linkedRefs are read from a ref keyed by their signature, so unrelated worktree
    // churn (activity stamps, unread flags) can't re-issue one read per linked ticket.
  }, [
    fetchLinearIssue,
    inOrcaLinkedLinearRefsSignature,
    linearConnected,
    linearMode,
    linearRefreshNonce,
    linearTaskSourceContext,
    inOrcaLinkedLinearRefsRef,
    lastLinearRequestRef,
    lastLinearRequestRef.current?.nonce,
    lastLinearRequestRef.current?.signature,
    refreshLinearIssue,
    setLinearError,
    setLinearIssues,
    setLinearIssuesHasMore,
    setLinearLoading,
    selectedLinearWorkspaceId,
    taskResumeApplied,
    taskSource
  ])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedLinearProjectSearch(linearProjectSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [linearProjectSearchInput, taskResumeApplied])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear' || linearMode !== 'projects') {
      return
    }
    if (!linearConnected || selectedLinearProject) {
      return
    }
    let cancelled = false
    const query = appliedLinearProjectSearch.trim()
    const cached = getCachedLinearProjects(query || undefined, LINEAR_ITEM_LIMIT, undefined, {
      sourceContext: linearTaskSourceContext
    })
    if (cached) {
      setLinearProjectsResult(cached)
    }
    const force = linearRefreshNonce > 0
    setLinearProjectsLoading(force || cached === null)
    setLinearProjectsError(null)
    void listLinearProjectsFromStore(query || undefined, LINEAR_ITEM_LIMIT, undefined, {
      force,
      sourceContext: linearTaskSourceContext
    })
      .then((result) => {
        if (!cancelled) {
          setLinearProjectsResult(result)
          setLinearProjectsLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectsError(
            error instanceof Error ? error.message : 'Failed to load projects.'
          )
          setLinearProjectsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskResumeApplied,
    taskSource,
    linearMode,
    linearConnected,
    selectedLinearWorkspaceId,
    selectedLinearProject,
    appliedLinearProjectSearch,
    linearRefreshNonce,
    getCachedLinearProjects,
    linearTaskSourceContext
  ])

  useEffect(() => {
    if (!selectedLinearProject?.workspaceId) {
      setSelectedLinearProjectDetail(null)
      return
    }
    let cancelled = false
    setLinearProjectDetailLoading(true)
    setLinearProjectDetailError(null)
    void fetchLinearProject(selectedLinearProject.id, selectedLinearProject.workspaceId, {
      force: linearRefreshNonce > 0,
      sourceContext: linearTaskSourceContext
    })
      .then((project) => {
        if (!cancelled) {
          setSelectedLinearProjectDetail(project)
          setLinearProjectDetailLoading(false)
          if (!project) {
            setSelectedLinearProject(null)
            setLinearProjectParentView(null)
            setLinearProjectDetailError(null)
            setLinearProjectsError('Project was not found.')
            setTaskResumeState({ linearContext: undefined })
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectDetailError(
            error instanceof Error ? error.message : 'Failed to load project.'
          )
          setLinearProjectDetailLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    fetchLinearProject,
    linearRefreshNonce,
    selectedLinearProject,
    setTaskResumeState,
    linearTaskSourceContext
  ])

  useEffect(() => {
    if (!selectedLinearProject?.workspaceId || linearProjectTab !== 'issues') {
      return
    }
    let cancelled = false
    setLinearProjectIssuesLoading(true)
    setLinearProjectIssuesError(null)
    const effectiveLimit = clampLinearIssueListLimit(linearProjectIssueLimit)
    void listLinearProjectIssues(
      selectedLinearProject.id,
      selectedLinearProject.workspaceId,
      effectiveLimit,
      { force: linearRefreshNonce > 0, sourceContext: linearTaskSourceContext }
    )
      .then((result) => {
        if (!cancelled) {
          setLinearProjectIssuesResult(result)
          setLinearProjectIssuesLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectIssuesError(
            error instanceof Error ? error.message : 'Failed to load project issues.'
          )
          setLinearProjectIssuesLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    linearProjectIssueLimit,
    linearProjectTab,
    linearRefreshNonce,
    listLinearProjectIssues,
    linearTaskSourceContext,
    selectedLinearProject
  ])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear' || linearMode !== 'views') {
      return
    }
    if (!linearConnected || selectedLinearCustomView) {
      return
    }
    let cancelled = false
    const cachedResults = LINEAR_CUSTOM_VIEW_MODELS.map((model) =>
      getCachedLinearCustomViews(model, LINEAR_ITEM_LIMIT, undefined, {
        sourceContext: linearTaskSourceContext
      })
    )
    const allCached = cachedResults.every(
      (result): result is LinearCollectionResult<LinearCustomViewSummary> => result !== null
    )
    if (allCached) {
      setLinearCustomViewsResult(mergeLinearCollectionResults(cachedResults))
    }
    const force = linearRefreshNonce > 0
    setLinearCustomViewsLoading(force || !allCached)
    setLinearCustomViewsError(null)
    // Why: the Views tab already has a Model column, so list both models rather than add a redundant Issues/Projects switch.
    void Promise.all(
      LINEAR_CUSTOM_VIEW_MODELS.map((model) =>
        listLinearCustomViews(model, LINEAR_ITEM_LIMIT, undefined, {
          force,
          sourceContext: linearTaskSourceContext
        })
      )
    )
      .then((result) => {
        if (!cancelled) {
          setLinearCustomViewsResult(mergeLinearCollectionResults(result))
          setLinearCustomViewsLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearCustomViewsError(
            error instanceof Error ? error.message : 'Failed to load views.'
          )
          setLinearCustomViewsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskResumeApplied,
    taskSource,
    linearMode,
    linearConnected,
    selectedLinearWorkspaceId,
    selectedLinearCustomView,
    linearRefreshNonce,
    getCachedLinearCustomViews,
    listLinearCustomViews,
    linearTaskSourceContext
  ])

  useEffect(() => {
    if (!selectedLinearCustomView?.workspaceId) {
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewProjectsResult({ items: [] })
      return
    }
    let cancelled = false
    setLinearCustomViewContentsLoading(true)
    setLinearCustomViewContentsError(null)
    const issueLimit = clampLinearIssueListLimit(linearCustomViewIssueLimit)
    const request =
      selectedLinearCustomView.model === 'issue'
        ? listLinearCustomViewIssues(
            selectedLinearCustomView.id,
            selectedLinearCustomView.workspaceId,
            issueLimit,
            { force: linearRefreshNonce > 0, sourceContext: linearTaskSourceContext }
          )
        : listLinearCustomViewProjects(
            selectedLinearCustomView.id,
            selectedLinearCustomView.workspaceId,
            LINEAR_ITEM_LIMIT,
            { force: linearRefreshNonce > 0, sourceContext: linearTaskSourceContext }
          )
    void request
      .then((result) => {
        if (cancelled) {
          return
        }
        if (selectedLinearCustomView.model === 'issue') {
          setLinearCustomViewIssuesResult(result as LinearCollectionResult<LinearIssue>)
        } else {
          setLinearCustomViewProjectsResult(result as LinearCollectionResult<LinearProjectSummary>)
        }
        setLinearCustomViewContentsLoading(false)
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearCustomViewContentsError(
            error instanceof Error ? error.message : 'Failed to load view contents.'
          )
          setLinearCustomViewContentsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    linearRefreshNonce,
    linearCustomViewIssueLimit,
    listLinearCustomViewIssues,
    listLinearCustomViewProjects,
    linearTaskSourceContext,
    selectedLinearCustomView
  ])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear') {
      return
    }

    if (!linearConnected) {
      clearSelectedLinearIssue()
      return
    }

    if (filteredLinearIssues.length === 0) {
      if (!selectedLinearIssueCanFloat) {
        clearSelectedLinearIssue()
      }
      return
    }

    // Why: list-first — keep an open inspector only while its issue stays in the filter, not auto-open row 1; user-directed sub-issue nav stays.
    if (
      selectedLinearIssueId &&
      !selectedLinearIssueCanFloat &&
      !filteredLinearIssues.some((issue) => issue.id === selectedLinearIssueId)
    ) {
      clearSelectedLinearIssue()
    }
  }, [
    clearSelectedLinearIssue,
    filteredLinearIssues,
    linearConnected,
    selectedLinearIssueCanFloat,
    selectedLinearIssueId,
    taskResumeApplied,
    taskSource
  ])

  useTaskPageJiraFetch({
    taskResumeApplied,
    jiraSearchInput,
    setAppliedJiraSearch,
    jiraSearchPersistReadyRef,
    appliedJiraSearch,
    setTaskResumeState,
    taskSource,
    jiraConnected,
    setJiraLoading,
    setJiraError,
    setJiraErrorDetailsOpen,
    searchJiraIssues,
    listJiraIssues,
    activeJiraPreset,
    jiraTaskSourceContext,
    selectedJiraSiteId,
    jiraRefreshNonce,
    jiraTaskSourceScopeKey,
    settings,
    setJiraIssues,
    setJiraProjectStatusOrder,
    displayedJiraIssues,
    selectedJiraIssueKey,
    setSelectedJiraIssueKey,
    selectedJiraIssueFallback,
    setSelectedJiraIssueFallback
  })

  const {
    handleUseLinearItem,
    handleOpenOrUseLinearItem,
    handleLinearWorkspaceChange,
    handleLinearTeamSelectionChange,
    handleLinearScopeOpen,
    handleLinearAccessConnected
  } = useTaskPageLinearActions({
    linearTaskSourceContext,
    openModal,
    clearSelectedLinearIssue,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    setLinearProjectTab,
    setLinearProjectsResult,
    setLinearCustomViewsResult,
    setLinearProjectIssuesResult,
    setLinearCustomViewIssuesResult,
    setLinearCustomViewProjectsResult,
    setLinearProjectDetailError,
    setLinearProjectsError,
    setLinearCustomViewsError,
    setLinearCustomViewContentsError,
    setTaskResumeState,
    linearMode,
    linearContextResumeAttemptedRef,
    setLinearIssues,
    setLinearError,
    setLinearLoading,
    selectLinearWorkspace,
    setLinearTeamRefreshNonce,
    setLinearTeamSelection,
    updateSettings,
    checkLinearConnection,
    listLinearTeams,
    selectedLinearWorkspaceId,
    setAvailableTeams,
    setLinearRefreshNonce
  })

  const { handleUseJiraItem } = useTaskPageJiraActions({
    jiraSites,
    jiraTaskSourceContext,
    openModal
  })

  const taskPageListChromeHidden = shouldHideTaskPageListChrome({
    taskSource,
    hasGitHubDetail: Boolean(dialogWorkItem),
    hasGitLabDetail: Boolean(gitlabDialogItem),
    hasJiraDetail: Boolean(selectedJiraIssue),
    hasLinearIssueDetail: Boolean(selectedLinearIssue),
    hasLinearProjectContext: Boolean(selectedLinearProject),
    hasLinearViewContext: Boolean(selectedLinearCustomView)
  })

  const sourceToolbar: TaskPageSourceToolbarProps = {
    closeTaskPage,
    visibleSourceOptions,
    taskSource,
    taskSourceAvailabilityNoticeByProvider,
    taskSourceManuallyChangedRef,
    openTaskPage,
    updateSettings,
    taskSourceContextSummary,
    linearConnected,
    linearWorkspaces,
    selectedLinearWorkspaceId,
    linearTeamOptions,
    linearTeamSelection,
    defaultLinearTeamSelection,
    onLinearWorkspaceChange: handleLinearWorkspaceChange,
    onLinearTeamSelectionChange: handleLinearTeamSelectionChange,
    onOpenLinearConnect: () => setLinearConnectOpen(true),
    onLinearScopeOpen: handleLinearScopeOpen,
    selectedLinearTeamForExternalLink,
    jiraConnected,
    jiraSites,
    selectedJiraSiteId,
    selectJiraSite,
    setSelectedJiraIssueKey,
    setSelectedJiraIssueFallback,
    setJiraIssues,
    setJiraError,
    setJiraLoading,
    taskSourceAvailabilityNotice
  }
  const githubModeBar: TaskPageGithubModeBarProps = {
    projectModeVisible,
    githubModeButtons,
    githubMode,
    activeGithubTaskKind,
    setGithubMode,
    setTaskResumeState,
    handleSelectGithubTaskKind,
    taskPickerGroups,
    repoSelection,
    getTaskPickerRepoHostLabel,
    eligibleRepos,
    setRepoSelection,
    updateSettings,
    taskPickerRepos,
    selectedGitHubRepoExternalLink
  }
  const githubItemFilters: TaskPageGithubItemFiltersProps = {
    activeGithubTaskKind,
    activeTaskPreset,
    setTaskSearchInput,
    setAppliedTaskSearch,
    setActiveTaskPreset,
    setTaskResumeState,
    setTaskRefreshNonce,
    handleSetDefaultTaskPreset,
    appliedTaskQuery,
    loadedGitHubAuthorLogins,
    primaryGithubFilterSlug,
    settings,
    applyPRFilterChange,
    taskSearchInputRef,
    taskSearchInput,
    handleTaskSearchChange,
    handleTaskSearchKeyDown,
    appliedTaskSearch,
    handleResetGithubTaskSearch,
    selectedRepos,
    setNewIssueTitle,
    setNewIssueBody,
    setNewIssueLabels,
    setNewIssueAssignees,
    setNewIssueRepoId,
    setNewIssueOpen,
    newIssueTargetRepo,
    handleRefreshGithubTasks,
    githubTasksBusy,
    perRepoSourceState,
    setIssueSourcePreference
  }
  const linearFilters: TaskPageLinearFiltersProps = {
    linearModeOptions,
    linearMode,
    selectLinearMode,
    selectedLinearProject,
    availableTeams,
    setNewLinearProjectName,
    setNewLinearProjectDescription,
    setNewLinearProjectContent,
    setNewLinearProjectTeamId,
    setNewLinearProjectLeadId,
    setNewLinearProjectMemberIds,
    setNewLinearProjectLabelIds,
    setNewLinearProjectPriority,
    setNewLinearProjectStartDate,
    setNewLinearProjectTargetDate,
    setNewLinearProjectOpen,
    setNewLinearIssueTitle,
    setNewLinearIssueBody,
    setNewLinearIssueTeamId,
    setNewLinearIssueProjectId,
    setNewLinearIssueOpen,
    setLinearRefreshNonce,
    linearLoading,
    linearProjectsLoading,
    linearProjectDetailLoading,
    linearCustomViewsLoading,
    linearCustomViewContentsLoading,
    showLinearAttributeFilters,
    linearAttributeFilter,
    applyLinearAttributeFilter,
    linearAttributeFilterWorkspaceId,
    linearAttributePrimaryTeam,
    linearTeamSelection,
    linearTeamOptions,
    linearTaskSourceContext,
    settings,
    linearSearchInput,
    setLinearSearchInput,
    setAppliedLinearSearch,
    setTaskResumeState,
    linearProjectSearchInput,
    setLinearProjectSearchInput,
    setAppliedLinearProjectSearch
  }
  const jiraFilters: TaskPageJiraFiltersProps = {
    jiraPresets,
    jiraSearchInput,
    activeJiraPreset,
    setJiraSearchInput,
    setAppliedJiraSearch,
    setActiveJiraPreset,
    setTaskResumeState,
    setJiraRefreshNonce,
    sortedAvailableJiraProjects,
    setNewJiraIssueTitle,
    setNewJiraIssueBody,
    setNewJiraIssueProjectId,
    setNewJiraIssueProjectQuery,
    setNewJiraIssueProjectCommandValue,
    setNewJiraIssueTypeId,
    setNewJiraIssueOpen,
    jiraProjectsLoading,
    jiraLoading
  }
  const gitlabFilters: TaskPageGitlabFiltersProps = {
    gitlabView,
    setGitlabView,
    taskPickerGroups,
    repoSelection,
    getTaskPickerRepoHostLabel,
    eligibleRepos,
    setRepoSelection,
    updateSettings,
    taskPickerRepos,
    gitLabIssueFilters,
    gitLabMRFilters,
    activeGitlabFilter,
    setGitlabFilter,
    setGitlabRefreshNonce,
    gitlabLoading,
    gitlabTodosLoading
  }
  const githubDetail: GithubDetailHostProps | null = dialogWorkItem
    ? {
        dialogWorkItem,
        dialogInitialTab,
        dialogRepoPath,
        dialogSourceContext,
        setDialogWorkItem,
        handleUseWorkItem,
        handleDialogReviewRequestsChange,
        closeTaskDetailPage
      }
    : null
  const githubTable: GithubWorkItemTableProps = {
    githubListScrollRef,
    githubResumeContextKey,
    currentPageRef,
    pendingGithubScrollRestoreRef,
    githubListScrollTopRef,
    taskListPositionRef,
    githubTaskGridClass,
    activeGithubTaskKind,
    showPRManagementColumns,
    tasksError,
    githubUnavailable,
    failedCount,
    selectedRepos,
    perRepoSourceState,
    handleRetryIssuesFetch,
    tasksLoading,
    retryingSourceKeys,
    unresolvedSourceRepos,
    showGitHubTaskSkeletons,
    filteredWorkItems,
    softHiddenVisibleCount,
    totalPages,
    githubEmptyState,
    repoMap,
    allWorktrees,
    openGitHubDetailPage,
    githubWorkItemMutation,
    ensurePRChecksLoaded,
    handleOpenOrUseGitHubWorkItem,
    handleUseWorkItem,
    currentPage,
    loadingTargetPage,
    pages,
    handleLoadNextPage,
    setCurrentPage
  }
  const gitlabList: GitlabWorkItemListProps = {
    gitlabError,
    gitlabLoading,
    gitlabItems,
    displayedGitLabItems,
    gitlabEmptyState,
    openGitLabDetailPage,
    handleUseGitLabItem
  }
  const jiraList: JiraIssueListHostProps = {
    jiraStatusReady,
    jiraConnected,
    setJiraConnectOpen,
    hideTaskSource,
    displayedJiraIssues,
    jiraOrderDirection,
    handleJiraSort,
    jiraOrderBy,
    jiraStatusCredentialError: jiraStatus.credentialError,
    jiraError,
    jiraErrorDetailsOpen,
    setJiraErrorDetailsOpen,
    jiraLoading,
    jiraIssues,
    jiraSearchInput,
    sortedJiraIssues,
    openJiraDetailPage,
    handleUseJiraItem,
    selectedJiraIssue,
    selectedJiraSiteId,
    displayedJiraStatusOrder,
    closeTaskDetailPage,
    jiraDetailSourceContext
  }
  const linearViews: LinearViewsHostProps = {
    selectedLinearIssue,
    activeLinearIssueContextLabel,
    handleUseLinearItem,
    openRelatedLinearIssue,
    closeTaskDetailPage,
    linearDetailSourceContext,
    linearStatusReady,
    linearConnected,
    setLinearConnectOpen,
    selectedLinearProject,
    linearProjectTab,
    selectedLinearProjectDetail,
    linearProjectDetailLoading,
    linearProjectDetailError,
    linearProjectParentView,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setLinearProjectTab,
    setLinearMode,
    setSelectedLinearCustomView,
    setTaskResumeState,
    setLinearProjectParentView,
    setLinearRefreshNonce,
    linearMode,
    linearProjectsError,
    linearProjectsResult,
    linearProjectsLoading,
    selectedLinearWorkspaceId,
    openLinearProjectContext,
    selectedLinearCustomView,
    linearCustomViewsError,
    linearCustomViewsResult,
    linearCustomViewsLoading,
    openLinearCustomViewContext,
    linearCustomViewContentsError,
    linearCustomViewProjectsResult,
    linearCustomViewContentsLoading,
    issueList: {
      toolbar: {
        activeLinearIssueContextLabel,
        selectedLinearProject,
        setLinearProjectTab,
        setSelectedLinearCustomView,
        setLinearProjectParentView,
        setTaskResumeState,
        linearMode,
        linearViewOptions,
        linearViewMode,
        setLinearViewMode,
        linearGroupBy,
        setLinearGroupBy,
        linearGroupOptions,
        linearOrderBy,
        setLinearOrderBy,
        linearOrderOptions,
        linearDisplayPropertyOptions,
        effectiveLinearDisplayProperties,
        toggleLinearDisplayProperty,
        linearIssueGridStyle
      },
      empty: {
        activeLinearIssueError,
        activeLinearIssueLoading,
        activeLinearIssues,
        activeLinearIssueHasCollectionError,
        linearMode,
        linearSearchActive,
        activeLinearIssueContextLabel,
        linearAttributeFilter,
        filteredLinearIssues,
        linearIssuesHasMore,
        setLinearIssueLimit
      },
      board: {
        linearBoardSections,
        handleLinearBoardDragOver,
        handleLinearBoardDrop,
        linearBoardDragOverKey,
        selectedLinearIssueId,
        linearBoardDraggingIssueId,
        linearBoardUpdatingIssueIds,
        selectedLinearWorkspaceId,
        linearIssueAttachmentIndex,
        linearStatusBoardEnabled,
        handleLinearBoardCardDragStart,
        setLinearBoardDraggingIssueId,
        setLinearBoardDragOverKey,
        openLinearDetailPage,
        effectiveLinearDisplayProperties,
        handleOpenOrUseLinearItem,
        linearTaskSourceContext
      },
      list: {
        linearIssueListRows,
        selectedLinearIssueId,
        selectedLinearWorkspaceId,
        linearIssueAttachmentIndex,
        openLinearDetailPage,
        linearIssueGridStyle,
        effectiveLinearDisplayProperties,
        linearTaskSourceContext,
        handleOpenOrUseLinearItem
      },
      linearViewMode,
      selectedLinearProject,
      linearProjectTab,
      selectedLinearCustomView,
      linearProjectIssuesResult,
      linearCustomViewIssuesResult,
      linearIssues,
      showLinearEmptyFilteredLoadMore,
      handleLinearEmptyFilteredLoadMore,
      activeLinearIssueLoading,
      showLinearIssuePagination,
      visibleLinearIssuePage,
      linearIssueTotalPages,
      activeLinearIssueLoadingTargetPage,
      handleLinearIssuePageChange,
      pagedLinearIssuesCount: pagedLinearIssues.length
    }
  }
  const newGithubIssue: NewGithubIssueDialogProps = {
    newIssueOpen,
    newIssueSubmitting,
    setNewIssueOpen,
    handleCreateNewIssue,
    newIssueTargetRepo,
    perRepoSourceState,
    setIssueSourcePreference,
    selectedRepos,
    newIssueRepoId,
    setNewIssueRepoId,
    setNewIssueLabels,
    setNewIssueAssignees,
    newIssueTitle,
    setNewIssueTitle,
    newIssueBody,
    setNewIssueBody,
    newIssueRepoLabels,
    newIssueLabels,
    newIssueRepoAssignees,
    newIssueAssignees,
    submitShortcutLabel
  }
  const newLinearProject: NewLinearProjectDialogProps = {
    newLinearProjectOpen,
    newLinearProjectSubmitting,
    setNewLinearProjectOpen,
    handleCreateNewLinearProject,
    availableTeams,
    newLinearProjectTargetTeam,
    setNewLinearProjectTeamId,
    newLinearProjectName,
    setNewLinearProjectName,
    newLinearProjectDescription,
    setNewLinearProjectDescription,
    newLinearProjectContent,
    setNewLinearProjectContent,
    submitShortcutLabel,
    newLinearProjectPriority,
    setNewLinearProjectPriority,
    newLinearProjectMembers,
    newLinearProjectLeadId,
    setNewLinearProjectLeadId,
    newLinearProjectMemberIds,
    setNewLinearProjectMemberIds,
    newLinearProjectLabelIds,
    setNewLinearProjectLabelIds,
    newLinearProjectLabels,
    newLinearProjectStartDate,
    setNewLinearProjectStartDate,
    newLinearProjectTargetDate,
    setNewLinearProjectTargetDate
  }
  const newLinearIssue: NewLinearIssueDialogProps = {
    newLinearIssueOpen,
    newLinearIssueSubmitting,
    setNewLinearIssueOpen,
    handleCreateNewLinearIssue,
    availableTeams,
    newLinearIssueTargetTeam,
    newLinearIssueTeamId,
    setNewLinearIssueTeamId,
    newLinearIssueTitle,
    setNewLinearIssueTitle,
    newLinearIssueBody,
    setNewLinearIssueBody,
    submitShortcutLabel,
    newLinearStates,
    newLinearIssueStateId,
    setNewLinearIssueStateId,
    newLinearMembers,
    newLinearIssueAssigneeId,
    setNewLinearIssueAssigneeId,
    newLinearIssuePriority,
    setNewLinearIssuePriority,
    newLinearIssueProjects,
    newLinearIssueProjectId,
    setNewLinearIssueProjectId,
    newLinearIssueProjectsLoading,
    newLinearIssueLabelIds,
    setNewLinearIssueLabelIds,
    newLinearLabels
  }
  const newJiraIssue: NewJiraIssueDialogProps = {
    newJiraIssueOpen,
    newJiraIssueSubmitting,
    setNewJiraIssueOpen,
    handleCreateNewJiraIssue,
    newJiraIssueTargetProject,
    newJiraIssueProjectComboboxOpen,
    handleNewJiraIssueProjectComboboxOpenChange,
    handleNewJiraIssueProjectTriggerKeyDown,
    sortedAvailableJiraProjects,
    includeJiraSiteNameInProjectLabel,
    newJiraIssueProjectCommandValue,
    setNewJiraIssueProjectCommandValue,
    newJiraIssueProjectSearchInputRef,
    newJiraIssueProjectQuery,
    setNewJiraIssueProjectQuery,
    filteredNewJiraIssueProjects,
    newJiraIssueTargetProjectSelectionKey,
    handleNewJiraIssueProjectSelect,
    newJiraIssueTypeId,
    newJiraIssueTargetType,
    setNewJiraIssueTypeId,
    jiraIssueTypesLoading,
    availableJiraIssueTypes,
    newJiraIssueTitle,
    setNewJiraIssueTitle,
    newJiraIssueBody,
    setNewJiraIssueBody,
    jiraCreateFieldsLoading,
    jiraCreateFieldsError,
    visibleJiraCreateFields,
    newJiraIssueCustomFieldValues,
    setNewJiraIssueCustomFieldValues,
    submitShortcutLabel,
    hasMissingJiraCreateField
  }
  const connectDialogs: TaskPageConnectDialogsProps = {
    gitlabDialogItem,
    gitlabDialogRepo,
    gitlabDialogSourceContext,
    setGitlabDialogItem,
    handleUseGitLabItem,
    linearConnectOpen,
    setLinearConnectOpen,
    selectedLinearWorkspace,
    handleLinearAccessConnected,
    jiraConnectOpen,
    setJiraConnectOpen
  }

  return (
    <TaskPageLayout
      taskPageListChromeHidden={taskPageListChromeHidden}
      sourceToolbar={sourceToolbar}
      taskSource={taskSource}
      githubModeBar={githubModeBar}
      githubMode={githubMode}
      githubItemFilters={githubItemFilters}
      linearConnected={linearConnected}
      linearFilters={linearFilters}
      jiraConnected={jiraConnected}
      jiraFilters={jiraFilters}
      gitlabFilters={gitlabFilters}
      githubDetail={githubDetail}
      repoSelection={repoSelection}
      githubTable={githubTable}
      gitlabView={gitlabView}
      gitlabTodosLoading={gitlabTodosLoading}
      gitlabTodos={gitlabTodos}
      primaryRepo={primaryRepo}
      gitlabList={gitlabList}
      jiraList={jiraList}
      linearViews={linearViews}
      newGithubIssue={newGithubIssue}
      newLinearProject={newLinearProject}
      newLinearIssue={newLinearIssue}
      newJiraIssue={newJiraIssue}
      connectDialogs={connectDialogs}
    />
  )
}
