import { useCallback, useMemo } from 'react'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import type { AutomationDraft } from './AutomationEditorDialog'
import { getAutomationHostTargetFromKey, type AutomationHostTarget } from './automation-host-client'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { findAutomationRepo } from '../../../../shared/automation-repo-target'
import { getVisibleAutomationSetupDecision } from './automation-setup-decision'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Draft setup policy, selected history, and the page's legacy host target. */
export function useAutomationsPageSetupState({
  store,
  local,
  list,
  draftRepos = store.repos
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
  draftRepos?: AutomationsPageStoreState['repos']
}) {
  const { repos, projectHostSetups, worktreesByRepo, pendingAutomationRunNavigation } = store
  const {
    automationYamlHooksByRepoKey,
    automationHookCheckPromisesRef,
    setAutomationYamlHooksByRepoKey,
    setupDecisionTouchedRef,
    selectedAutomationRuns,
    runHistoryReloadToken,
    draft,
    automationHostTargetKey,
    selectedAutomationRunPageId
  } = local
  const { selected, selectedRow, selectedAutomationRunsWithWorkspaceNames: historyRuns } = list

  const getDraftSetupDecisionDefault = useCallback(
    (
      candidate: Pick<AutomationDraft, 'projectId' | 'workspaceMode'>
    ): AutomationDraft['setupDecision'] => {
      const owners = draftRepos.filter((repo) => repo.id === candidate.projectId)
      const setupHostId = owners.length === 1 ? getRepoExecutionHostId(owners[0]) : undefined
      const setupProjectHostSetups = setupHostId
        ? projectHostSetups.filter(
            (setup) => setup.repoId !== candidate.projectId || setup.hostId === setupHostId
          )
        : projectHostSetups
      const hookKey = `${setupHostId ?? 'unresolved'}:${candidate.projectId}`
      return getVisibleAutomationSetupDecision({
        workspaceMode: candidate.workspaceMode,
        repoId: candidate.projectId,
        repos: draftRepos,
        projectHostSetups: setupProjectHostSetups,
        yamlHooks: automationYamlHooksByRepoKey[hookKey]
      })
    },
    [automationYamlHooksByRepoKey, draftRepos, projectHostSetups]
  )
  const getAutomationHooksCacheKey = useCallback(
    (repoId: string, hostId?: string): string => {
      if (hostId) {
        return `${hostId}:${repoId}`
      }
      const owner = findAutomationRepo(repos, repoId)
      return `${owner ? getRepoExecutionHostId(owner) : 'unresolved'}:${repoId}`
    },
    [repos]
  )
  const loadAutomationYamlHooksForRepo = useCallback(
    async (
      repoId: string,
      hostId?: ExecutionHostId,
      options: { background?: boolean } = {}
    ): Promise<OrcaHooks | null> => {
      const key = getAutomationHooksCacheKey(repoId, hostId)
      if (Object.hasOwn(automationYamlHooksByRepoKey, key)) {
        return automationYamlHooksByRepoKey[key] ?? null
      }
      // A save must not join a preview check that refused a stopped WSL distro.
      const flightKey = options.background ? `${key}:background` : key
      const existingPromise = automationHookCheckPromisesRef.current.get(flightKey)
      if (existingPromise) {
        return (await existingPromise).hooks
      }
      // Why: a repo id on two hosts has no single owner to inspect; never let focus pick one.
      const ownerRows = hostId ? [] : repos.filter((repo) => repo.id === repoId)
      const ownerHostId =
        hostId ?? (ownerRows.length === 1 ? getRepoExecutionHostId(ownerRows[0]) : null)
      const promise = (
        ownerHostId
          ? checkRuntimeHooks(ownerHostId, repoId, options)
          : Promise.reject(new Error('The project host is unknown.'))
      )
        .then((result) => ({
          hooks: result.status === 'error' ? null : ((result.hooks as OrcaHooks | null) ?? null),
          ok: result.status !== 'error'
        }))
        .catch(() => ({ hooks: null, ok: false }))
      automationHookCheckPromisesRef.current.set(flightKey, promise)
      const { hooks, ok } = await promise
      automationHookCheckPromisesRef.current.delete(flightKey)
      if (!ok) {
        return hooks
      }
      setAutomationYamlHooksByRepoKey((current) =>
        Object.hasOwn(current, key) ? current : { ...current, [key]: hooks }
      )
      return hooks
    },
    [
      automationHookCheckPromisesRef,
      automationYamlHooksByRepoKey,
      getAutomationHooksCacheKey,
      repos,
      setAutomationYamlHooksByRepoKey
    ]
  )
  const getDraftSetupDecisionDefaultSignature = useCallback(
    (candidate: Pick<AutomationDraft, 'projectId' | 'workspaceMode'>): string =>
      [
        candidate.workspaceMode,
        candidate.projectId,
        getDraftSetupDecisionDefault(candidate) ?? 'none'
      ].join(':'),
    [getDraftSetupDecisionDefault]
  )
  const markSetupDecisionTouched = useCallback((): void => {
    setupDecisionTouchedRef.current = true
  }, [setupDecisionTouchedRef])

  const selectedRunsMatchSelection =
    selectedAutomationRuns.automationId === (selected?.id ?? store.selectedId) &&
    selectedAutomationRuns.rowKey === (selectedRow?.key ?? local.selectedRowKey)
  const selectedRunsReady =
    selectedRunsMatchSelection &&
    selectedAutomationRuns.reloadToken === runHistoryReloadToken &&
    (!pendingAutomationRunNavigation ||
      selectedAutomationRuns.navigation === pendingAutomationRunNavigation)
  const selectedRunsNotice = selectedRunsReady ? selectedAutomationRuns.notice : null
  const selectedRuns = useMemo(
    () =>
      selectedRunsMatchSelection
        ? historyRuns.filter((run) => run.automationId === selectedAutomationRuns.automationId)
        : [],
    [selectedAutomationRuns.automationId, selectedRunsMatchSelection, historyRuns]
  )
  const selectedAutomationRunPage = selectedAutomationRunPageId
    ? (selectedRuns.find((run) => run.id === selectedAutomationRunPageId) ?? null)
    : null
  const worktrees = useMemo(
    () => worktreesByRepo[draft.projectId] ?? [],
    [draft.projectId, worktreesByRepo]
  )
  const automationHostTarget: AutomationHostTarget | null = useMemo(
    () => getAutomationHostTargetFromKey(automationHostTargetKey),
    [automationHostTargetKey]
  )

  return {
    getDraftSetupDecisionDefault,
    getAutomationHooksCacheKey,
    loadAutomationYamlHooksForRepo,
    getDraftSetupDecisionDefaultSignature,
    markSetupDecisionTouched,
    selectedRuns,
    selectedRunsReady,
    selectedRunsNotice,
    selectedAutomationRunPage,
    worktrees,
    automationHostTarget
  }
}

export type AutomationsPageSetupState = ReturnType<typeof useAutomationsPageSetupState>
