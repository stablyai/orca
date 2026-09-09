import { useEffect, useMemo } from 'react'
import { filterAvailableTaskProviders } from '../../../../shared/task-providers'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getMrStateFilters, getSmartWorkspaceNameModes } from './smart-workspace-localized-options'
import {
  SEARCH_DEBOUNCE_MS,
  type NormalizedSmartWorkspaceNameFieldProps
} from './smart-workspace-name-field-model'
import { canUseGitLabSmartSource } from './smart-workspace-provider-availability'
import { useSmartWorkspaceFieldFocusControls } from './use-smart-workspace-field-focus-controls'
import type { useSmartWorkspaceNameFieldState } from './use-smart-workspace-name-field-state'

type FieldState = ReturnType<typeof useSmartWorkspaceNameFieldState>

export function useSmartWorkspaceFieldAvailability({
  props,
  state,
  repoBackedSearchTargets,
  preflightStatus,
  preflightStatusChecked,
  preflightStatusContextKey,
  expectedPreflightContextKey,
  refreshPreflightStatus,
  linearStatus,
  linearStatusChecked,
  checkLinearConnection,
  jiraSourceConnected
}: {
  props: NormalizedSmartWorkspaceNameFieldProps
  state: FieldState
  repoBackedSearchTargets: {
    gitlabSourceContext: { hostId?: ExecutionHostId | null } | null
  }[]
  preflightStatus: { glab?: { installed?: boolean } } | null
  preflightStatusChecked: boolean
  preflightStatusContextKey: string | null
  expectedPreflightContextKey: string
  refreshPreflightStatus: () => Promise<void>
  linearStatus: { connected?: boolean }
  linearStatusChecked: boolean
  checkLinearConnection: () => Promise<void>
  jiraSourceConnected: boolean
}) {
  const {
    disabled,
    textOnly,
    repoBackedSourcesDisabled,
    branchesEnabled,
    onActiveSourceModeChange,
    value
  } = props
  const {
    mode,
    setMode,
    setOpen,
    setGithubItems,
    setGitlabItems,
    setBranches,
    setGithubLoading,
    setGitlabLoading,
    setBranchesLoading,
    setBranchResultsSource,
    setCrossRepoPrompt,
    setLinearIssues,
    setJiraIssues,
    setLinearLoading,
    setJiraLoading,
    setCommandValue,
    setDebouncedQuery
  } = state

  useEffect(() => {
    onActiveSourceModeChange?.(mode)
  }, [mode, onActiveSourceModeChange])
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const localGitlabAvailable = preflightStatusCurrent && preflightStatus?.glab?.installed === true
  const gitlabSourceAvailable = repoBackedSearchTargets.some((target) =>
    canUseGitLabSmartSource({
      localGitlabAvailable,
      repoBackedSourcesDisabled,
      sourceHostId: target.gitlabSourceContext?.hostId
    })
  )
  const availableTaskProviders = useMemo(
    () =>
      filterAvailableTaskProviders(['github', 'gitlab', 'linear'], {
        gitlabInstalled: gitlabSourceAvailable,
        linearConnected: linearStatus.connected === true
      }),
    [gitlabSourceAvailable, linearStatus.connected]
  )
  const linearAvailable = availableTaskProviders.includes('linear')
  const availableModes = getSmartWorkspaceNameModes().filter((item) => {
    if (textOnly) {
      return item.id === 'text'
    }
    if (item.id === 'github') {
      return !repoBackedSourcesDisabled
    }
    if (item.id === 'gitlab') {
      return gitlabSourceAvailable
    }
    if (item.id === 'linear') {
      return linearAvailable
    }
    if (item.id === 'jira') {
      return jiraSourceConnected
    }
    if (item.id === 'branches') {
      return branchesEnabled && !repoBackedSourcesDisabled
    }
    return true
  })
  const mrStateFilters = getMrStateFilters()

  useEffect(() => {
    if (availableModes.some((item) => item.id === mode)) {
      return
    }
    setMode(availableModes[0]?.id ?? 'text')
  }, [availableModes, mode, setMode])

  useEffect(() => {
    if (!repoBackedSourcesDisabled) {
      return
    }
    setGithubItems([])
    setGitlabItems([])
    setBranches([])
    setGithubLoading(false)
    setGitlabLoading(false)
    setBranchesLoading(false)
    setBranchResultsSource(null)
    setCrossRepoPrompt(null)
  }, [
    repoBackedSourcesDisabled,
    setBranches,
    setBranchesLoading,
    setBranchResultsSource,
    setCrossRepoPrompt,
    setGithubItems,
    setGithubLoading,
    setGitlabItems,
    setGitlabLoading
  ])

  const focusControls = useSmartWorkspaceFieldFocusControls({ props, state })

  useEffect(() => {
    if (disabled || textOnly) {
      return
    }
    if (!preflightStatusChecked || !preflightStatusCurrent) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [
    checkLinearConnection,
    disabled,
    linearStatusChecked,
    preflightStatusChecked,
    preflightStatusCurrent,
    refreshPreflightStatus,
    textOnly
  ])

  useEffect(() => {
    if (textOnly) {
      if (mode !== 'text') {
        setMode('text')
      }
      setOpen(false)
      return
    }
    if ((mode === 'gitlab' && gitlabSourceAvailable) || (mode === 'linear' && linearAvailable)) {
      return
    }
    if (mode !== 'gitlab' && mode !== 'linear') {
      return
    }
    setMode('smart')
    setGitlabItems([])
    setLinearIssues([])
    setJiraIssues([])
    setGitlabLoading(false)
    setLinearLoading(false)
    setJiraLoading(false)
    setCommandValue('')
  }, [
    gitlabSourceAvailable,
    linearAvailable,
    mode,
    setCommandValue,
    setGitlabItems,
    setGitlabLoading,
    setJiraIssues,
    setJiraLoading,
    setLinearIssues,
    setLinearLoading,
    setMode,
    setOpen,
    textOnly
  ])

  useEffect(() => {
    if (!disabled) {
      return
    }
    setOpen(false)
    setGithubItems([])
    setGitlabItems([])
    setBranches([])
    setBranchResultsSource(null)
    setLinearIssues([])
    setJiraIssues([])
    setGithubLoading(false)
    setGitlabLoading(false)
    setBranchesLoading(false)
    setLinearLoading(false)
    setJiraLoading(false)
    setCommandValue('')
    setCrossRepoPrompt(null)
  }, [
    disabled,
    setBranches,
    setBranchesLoading,
    setBranchResultsSource,
    setCommandValue,
    setCrossRepoPrompt,
    setGithubItems,
    setGithubLoading,
    setGitlabItems,
    setGitlabLoading,
    setJiraIssues,
    setJiraLoading,
    setLinearIssues,
    setLinearLoading,
    setOpen
  ])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(value), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [setDebouncedQuery, value])

  return {
    gitlabSourceAvailable,
    linearAvailable,
    availableModes,
    mrStateFilters,
    ...focusControls
  }
}
