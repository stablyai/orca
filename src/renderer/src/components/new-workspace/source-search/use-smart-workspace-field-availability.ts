import { useEffect, useMemo } from 'react'
import { filterAvailableTaskProviders } from '../../../../../shared/work-items/task-providers'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getMrStateFilters, getSmartWorkspaceNameModes } from './smart-workspace-localized-options'
import {
  SEARCH_DEBOUNCE_MS,
  type NormalizedWorkItemSourceSearchProps
} from '../name-field/smart-workspace-name-field-model'
import { canUseGitLabSmartSource } from './smart-workspace-provider-availability'
import type { useWorkItemSourceState } from './use-work-item-source-state'
import { useTranslate } from '../../../i18n/use-translate'

type FieldState = ReturnType<typeof useWorkItemSourceState>

/**
 * Last known `glab` availability per preflight context. The preflight status is one app-wide slot:
 * opening the composer for a different host/workspace context invalidates it until the async probe
 * returns, which hid the GitLab source on some opens and showed it on others. Remembering the last
 * answer per context keeps GitLab steady while a fresh probe runs.
 */
const lastKnownGlabByContext = new Map<string, boolean>()

export function resolveLocalGitlabAvailable(args: {
  preflightStatusCurrent: boolean
  glabInstalled: boolean | undefined
  contextKey: string
  lastKnown: ReadonlyMap<string, boolean>
}): boolean {
  if (args.preflightStatusCurrent && args.glabInstalled !== undefined) {
    return args.glabInstalled
  }
  return args.lastKnown.get(args.contextKey) === true
}

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
  linearStatusPending,
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
  /** The searched host's Linear status is still loading. */
  linearStatusPending: boolean
  checkLinearConnection: () => Promise<void>
  jiraSourceConnected: boolean
}) {
  const t = useTranslate()
  const { disabled, textOnly, repoBackedSourcesDisabled, branchesEnabled, value } = props
  const { mode: storedMode, setMode, setDebouncedQuery } = state
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const glabInstalled = preflightStatusCurrent ? preflightStatus?.glab?.installed : undefined
  useEffect(() => {
    if (glabInstalled !== undefined) {
      lastKnownGlabByContext.set(expectedPreflightContextKey, glabInstalled)
    }
  }, [expectedPreflightContextKey, glabInstalled])
  const localGitlabAvailable = resolveLocalGitlabAvailable({
    preflightStatusCurrent,
    glabInstalled,
    contextKey: expectedPreflightContextKey,
    lastKnown: lastKnownGlabByContext
  })
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
  const availableModes = getSmartWorkspaceNameModes(t).filter((item) => {
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
  // Why: an unknown status is not a disconnect; keep a chosen Linear tab until it settles.
  const mode =
    availableModes.some((item) => item.id === storedMode) ||
    (storedMode === 'linear' && linearStatusPending && !textOnly) ||
    (storedMode === 'gitlab' && !preflightStatusCurrent && !textOnly && !repoBackedSourcesDisabled)
      ? storedMode
      : (availableModes[0]?.id ?? 'text')
  useEffect(() => {
    if (storedMode !== mode) {
      setMode(mode)
    }
  }, [storedMode, setMode, mode])
  const mrStateFilters = getMrStateFilters(t)

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
