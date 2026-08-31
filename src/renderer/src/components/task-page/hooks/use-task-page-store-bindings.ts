import { useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getScreenSubmitShortcutLabel } from '@/lib/screen-submit-shortcut'
import { getTaskEligibleRepos } from '@/components/task-page-default-repo-selection'

export function useTaskPageStoreBindings() {
  useTranslation()
  const settings = useAppStore((s) => s.settings)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const taskResumeState = useAppStore((s) => s.taskResumeState)
  const setTaskResumeState = useAppStore((s) => s.setTaskResumeState)
  const pageData = useAppStore((s) => s.taskPageData)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const closeTaskPage = useAppStore((s) => s.closeTaskPage)
  const activeModal = useAppStore((s) => s.activeModal)
  const repos = useAppStore((s) => s.repos)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const repoMap = useRepoMap()
  const allWorktrees = useAllWorktrees()
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchWorkItemsAcrossRepos = useAppStore((s) => s.fetchWorkItemsAcrossRepos)
  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const getCachedWorkItems = useAppStore((s) => s.getCachedWorkItems)
  const setIssueSourcePreference = useAppStore((s) => s.setIssueSourcePreference)
  // Why: bumped after cache eviction to re-run the fetch effect — eviction alone won't, since its deps don't include workItemsCache.
  const workItemsInvalidationNonce = useAppStore((s) => s.workItemsInvalidationNonce)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const selectLinearWorkspace = useAppStore((s) => s.selectLinearWorkspace)
  const searchLinearIssues = useAppStore((s) => s.searchLinearIssues)
  const listLinearIssues = useAppStore((s) => s.listLinearIssues)
  const linearListInvalidationToken = useAppStore((s) => s.linearListInvalidationToken)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const invalidateLinearIssueLists = useAppStore((s) => s.invalidateLinearIssueLists)
  const getCachedLinearIssues = useAppStore((s) => s.getCachedLinearIssues)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const refreshLinearIssue = useAppStore((s) => s.refreshLinearIssue)
  const getCachedLinearTeams = useAppStore((s) => s.getCachedLinearTeams)
  const listLinearTeams = useAppStore((s) => s.listLinearTeams)
  const getCachedLinearProjects = useAppStore((s) => s.getCachedLinearProjects)
  const listLinearProjectsFromStore = useAppStore((s) => s.listLinearProjects)
  const fetchLinearProject = useAppStore((s) => s.fetchLinearProject)
  const listLinearProjectIssues = useAppStore((s) => s.listLinearProjectIssues)
  const getCachedLinearCustomViews = useAppStore((s) => s.getCachedLinearCustomViews)
  const listLinearCustomViews = useAppStore((s) => s.listLinearCustomViews)
  const fetchLinearCustomView = useAppStore((s) => s.fetchLinearCustomView)
  const listLinearCustomViewIssues = useAppStore((s) => s.listLinearCustomViewIssues)
  const listLinearCustomViewProjects = useAppStore((s) => s.listLinearCustomViewProjects)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const selectJiraSite = useAppStore((s) => s.selectJiraSite)
  const searchJiraIssues = useAppStore((s) => s.searchJiraIssues)
  const listJiraIssues = useAppStore((s) => s.listJiraIssues)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const providerRuntimeContextKeyRef = useRef(providerRuntimeContextKey)
  useLayoutEffect(() => {
    providerRuntimeContextKeyRef.current = providerRuntimeContextKey
  }, [providerRuntimeContextKey])
  const linearStatusCurrent = linearStatusContextKey === providerRuntimeContextKey
  const jiraStatusCurrent = jiraStatusContextKey === providerRuntimeContextKey
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const linearStatusReady = linearStatusCurrent && linearStatusChecked
  const jiraStatusReady = jiraStatusCurrent && jiraStatusChecked
  const linearConnected = linearStatusCurrent && linearStatus.connected
  const jiraConnected = jiraStatusCurrent && jiraStatus.connected
  const submitShortcutLabel = getScreenSubmitShortcutLabel()
  const eligibleRepos = useMemo(() => getTaskEligibleRepos(repos), [repos])

  return {
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
    linearStatusChecked,
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
    jiraStatusChecked,
    jiraStatusContextKey,
    selectJiraSite,
    searchJiraIssues,
    listJiraIssues,
    checkJiraConnection,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    linearStatusCurrent,
    jiraStatusCurrent,
    preflightStatusCurrent,
    linearStatusReady,
    jiraStatusReady,
    linearConnected,
    jiraConnected,
    submitShortcutLabel,
    eligibleRepos
  }
}
