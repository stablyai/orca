import { useEffect, useMemo } from 'react'
import { filterAvailableTaskProviders } from '../../../../shared/task-providers'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getMrStateFilters, getSmartWorkspaceNameModes } from './smart-workspace-localized-options'
import {
  SEARCH_DEBOUNCE_MS,
  type NormalizedWorkItemSourceSearchProps
} from './smart-workspace-name-field-model'
import { canUseGitLabSmartSource } from './smart-workspace-provider-availability'
import type { useWorkItemSourceState } from './use-work-item-source-state'

type FieldState = ReturnType<typeof useWorkItemSourceState>

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
  props: NormalizedWorkItemSourceSearchProps
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
  const { disabled, textOnly, repoBackedSourcesDisabled, branchesEnabled, value } = props
  const { mode: storedMode, setMode, setDebouncedQuery } = state
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
    return item.id !== 'text' || props.typedTextEnabled === true
  })
  const mode = availableModes.some((item) => item.id === storedMode)
    ? storedMode
    : (availableModes[0]?.id ?? 'text')
  useEffect(() => {
    if (storedMode !== mode) {
      setMode(mode)
    }
  }, [storedMode, setMode, mode])
  const mrStateFilters = getMrStateFilters()

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
    const timer = window.setTimeout(() => setDebouncedQuery(value), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [setDebouncedQuery, value])

  return {
    mode,
    gitlabSourceAvailable,
    linearAvailable,
    availableModes,
    mrStateFilters
  }
}
