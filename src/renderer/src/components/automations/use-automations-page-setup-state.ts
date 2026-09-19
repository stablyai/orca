import { useCallback, useMemo } from 'react'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import type { AutomationDraft } from './AutomationEditorDialog'
import { getAutomationHostTargetFromKey, type AutomationHostTarget } from './automation-host-client'
import { getAutomationCreateRepos } from './automation-create-projects'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getVisibleAutomationSetupDecision } from './automation-setup-decision'
import { capturedAutomationOwner, capturedAutomationOwnerKey } from './automation-captured-owner'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Draft setup policy, selected history, and the page's legacy host target. */
export function useAutomationsPageSetupState({
  store,
  local,
  list
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
}) {
  const { repos, settings, projectHostSetups, worktreesByRepo } = store
  const {
    createTarget,
    automationYamlHooksByRepoKey,
    automationHookCheckPromisesRef,
    setAutomationYamlHooksByRepoKey,
    setupDecisionTouchedRef,
    selectedAutomationRuns,
    draft,
    automationHostTargetKey,
    selectedAutomationRunPageId
  } = local
  const {
    selected,
    selectedRow,
    selectedAutomationRunsWithWorkspaceNames,
    capturedAutomationOwners
  } = list

  const getDraftSetupDecisionDefault = useCallback(
    (
      candidate: Pick<AutomationDraft, 'projectId' | 'workspaceMode'>
    ): AutomationDraft['setupDecision'] => {
      // During an edit the selected destination, not the ambient repo-id lookup,
      // owns setup policy. Repo ids can collide across runtime authorities.
      const selectedEditEntry =
        local.editingAutomationId !== null && local.editingHostStableKey
          ? list.hostCatalog.entries.find((entry) => entry.stableKey === local.editingHostStableKey)
          : null
      const selectedEditAuthority = selectedEditEntry?.stableRef.authority
      const setupHostId =
        selectedEditAuthority?.kind === 'runtime'
          ? toRuntimeExecutionHostId(selectedEditAuthority.environmentId)
          : undefined
      const setupRepos =
        selectedEditAuthority?.kind === 'runtime'
          ? getAutomationCreateRepos(repos, {
              kind: 'environment',
              environmentId: selectedEditAuthority.environmentId
            })
          : repos
      const setupProjectHostSetups = setupHostId
        ? projectHostSetups.filter(
            (setup) => setup.repoId !== candidate.projectId || setup.hostId === setupHostId
          )
        : projectHostSetups
      const settingsForRepo = setupHostId
        ? {
            ...settings,
            activeRuntimeEnvironmentId:
              selectedEditAuthority?.kind === 'runtime' ? selectedEditAuthority.environmentId : null
          }
        : getSettingsForRepoRuntimeOwner({ repos, settings }, candidate.projectId)
      const hookKey = `${setupHostId ?? settingsForRepo.activeRuntimeEnvironmentId ?? 'local'}:${candidate.projectId}`
      return getVisibleAutomationSetupDecision({
        createTarget,
        workspaceMode: candidate.workspaceMode,
        repoId: candidate.projectId,
        repos: setupRepos,
        projectHostSetups: setupProjectHostSetups,
        yamlHooks: automationYamlHooksByRepoKey[hookKey]
      })
    },
    [
      automationYamlHooksByRepoKey,
      createTarget,
      list.hostCatalog.entries,
      local.editingAutomationId,
      local.editingHostStableKey,
      projectHostSetups,
      repos,
      settings
    ]
  )
  const getAutomationHooksCacheKey = useCallback(
    (repoId: string, hostId?: string): string => {
      if (hostId) {
        return `${hostId}:${repoId}`
      }
      const settingsForRepo = getSettingsForRepoRuntimeOwner({ repos, settings }, repoId)
      return `${settingsForRepo.activeRuntimeEnvironmentId ?? 'local'}:${repoId}`
    },
    [repos, settings]
  )
  const loadAutomationYamlHooksForRepo = useCallback(
    async (repoId: string, hostId?: ExecutionHostId): Promise<OrcaHooks | null> => {
      const key = getAutomationHooksCacheKey(repoId, hostId)
      if (Object.hasOwn(automationYamlHooksByRepoKey, key)) {
        return automationYamlHooksByRepoKey[key] ?? null
      }
      const existingPromise = automationHookCheckPromisesRef.current.get(key)
      if (existingPromise) {
        return (await existingPromise).hooks
      }
      const settingsForRepo = getSettingsForRepoRuntimeOwner({ repos, settings }, repoId)
      const promise = checkRuntimeHooks(settingsForRepo, repoId, hostId)
        .then((result) => ({
          hooks: result.status === 'error' ? null : ((result.hooks as OrcaHooks | null) ?? null),
          ok: result.status !== 'error'
        }))
        .catch(() => ({ hooks: null, ok: false }))
      automationHookCheckPromisesRef.current.set(key, promise)
      const { hooks, ok } = await promise
      automationHookCheckPromisesRef.current.delete(key)
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
      setAutomationYamlHooksByRepoKey,
      settings
    ]
  )
  const getDraftSetupDecisionDefaultSignature = useCallback(
    (candidate: Pick<AutomationDraft, 'projectId' | 'workspaceMode'>): string =>
      [
        createTarget,
        candidate.workspaceMode,
        candidate.projectId,
        getDraftSetupDecisionDefault(candidate) ?? 'none'
      ].join(':'),
    [createTarget, getDraftSetupDecisionDefault]
  )
  const markSetupDecisionTouched = useCallback((): void => {
    setupDecisionTouchedRef.current = true
  }, [setupDecisionTouchedRef])

  const selectedRunsMatchSelection =
    selectedRow !== null &&
    selectedAutomationRuns.rowKey === selectedRow.key &&
    selectedAutomationRuns.ownerKey ===
      capturedAutomationOwnerKey(capturedAutomationOwner(capturedAutomationOwners, selectedRow.key))
  const selectedRunsNotice = selectedRunsMatchSelection ? selectedAutomationRuns.notice : null
  const selectedRuns = useMemo(
    () =>
      selected && selectedRunsMatchSelection
        ? selectedAutomationRunsWithWorkspaceNames.filter((run) => run.automationId === selected.id)
        : [],
    [selected, selectedRunsMatchSelection, selectedAutomationRunsWithWorkspaceNames]
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
    selectedRunsNotice,
    selectedAutomationRunPage,
    worktrees,
    automationHostTarget
  }
}

export type AutomationsPageSetupState = ReturnType<typeof useAutomationsPageSetupState>
