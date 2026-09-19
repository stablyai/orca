import { useCallback, useEffect, useMemo } from 'react'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { getAutomationCreateRepos } from './automation-create-projects'
import {
  automationCreateEligibleProjects,
  automationCreateHostStableKey,
  automationCreateProjectMismatch,
  resolveAutomationCreateDestination,
  type AutomationCreateDestination
} from './automation-create-destination'
import {
  getAutomationAuthorityTarget,
  getAutomationListTarget,
  getAutomationOwnerTarget,
  getAutomationTargetFromHostId,
  type AutomationHostTarget
} from './automation-host-client'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { capturedAutomationOwner, type AutomationCapturedOwner } from './automation-captured-owner'
import { buildAutomationRunContextForRepo } from './automation-run-context'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { AutomationsPageDestinationState } from './use-automations-page-destination-state'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Editor project/workspace projections for the captured create or edit host. */
export function useAutomationsPageDestinationForm({
  store,
  local,
  list,
  base
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
  base: AutomationsPageDestinationState
}) {
  const {
    repos,
    projectHostSetups,
    worktreesByRepo,
    fetchRuntimeEnvironmentRepos,
    fetchWorktrees,
    settings
  } = store
  const {
    createOpen,
    createTarget,
    editingAutomationId,
    editingRowKey,
    editingHostStableKey,
    setEditingHostStableKey,
    setEditingDestination,
    setDraft,
    draft,
    draftRef
  } = local
  const { visibleRows, hostCatalog, capturedAutomationOwners } = list
  const { automationHostTarget, automationHostTargetForRowKey, repoTables, editorProjects } = base
  const editingRow = editingRowKey
    ? (visibleRows.find((row) => row.key === editingRowKey) ?? null)
    : null
  const editingRowCapturedOwner: AutomationCapturedOwner['owner'] = capturedAutomationOwner(
    capturedAutomationOwners,
    editingRowKey
  ).owner
  const automationDialogTarget: AutomationHostTarget = (() => {
    if (editingAutomationId === null) {
      return getAutomationListTarget(settings)
    }
    if (editingRow && !editingRowCapturedOwner) {
      return getAutomationOwnerTarget(editingRow.automation, automationHostTarget)
    }
    return (
      automationHostTargetForRowKey(editingRowKey) ??
      getAutomationTargetFromHostId(editingRow?.automation.runContext?.hostId)
    )
  })()
  const isOrcaForm = createTarget === 'orca' && local.editingExternalTarget === null
  const dialogAuthorityRepos = getAutomationCreateRepos(repos, automationDialogTarget)
  const dialogAuthorityKey = automationAuthorityCatalogKey(
    automationDialogTarget.kind === 'environment'
      ? { kind: 'runtime', environmentId: automationDialogTarget.environmentId }
      : { kind: 'desktop' }
  )
  const editHostEntries = hostCatalog.entries
  const editHostResolution = resolveAutomationCreateDestination(
    editingHostStableKey
      ? editHostEntries.find((entry) => entry.stableKey === editingHostStableKey)
      : null
  )
  const editHostProjects =
    editHostResolution.status === 'ready'
      ? automationCreateEligibleProjects(
          repoTables,
          editHostResolution,
          getAutomationCreateRepos(
            repos,
            getAutomationAuthorityTarget(editHostResolution.authority)
          )
        )
      : dialogAuthorityRepos
  const editMoveTargetEntry =
    editHostResolution.status === 'ready' &&
    automationAuthorityCatalogKey(editHostResolution.authority) !== dialogAuthorityKey
      ? editHostResolution.entry
      : null
  const editDestinationRuntimeEnvironmentId =
    editHostResolution.status === 'ready' && editHostResolution.authority.kind === 'runtime'
      ? editHostResolution.authority.environmentId
      : null
  useEffect(() => {
    if (editDestinationRuntimeEnvironmentId) {
      void fetchRuntimeEnvironmentRepos(editDestinationRuntimeEnvironmentId)
    }
  }, [editDestinationRuntimeEnvironmentId, fetchRuntimeEnvironmentRepos])

  const handleEditHostChange = (stableKey: string): void => {
    setEditingHostStableKey(stableKey)
    const resolved = resolveAutomationCreateDestination(
      editHostEntries.find((entry) => entry.stableKey === stableKey)
    )
    const projectId = draftRef.current.projectId
    if (
      projectId &&
      resolved.status === 'ready' &&
      !automationCreateProjectMismatch(repoTables, resolved, projectId)
    ) {
      setEditingDestination({ projectId, destination: resolved })
      if (editingHostStableKey !== stableKey) {
        setDraft((current) => ({ ...current, workspaceId: '', baseBranch: '' }))
        if (resolved.authority.kind === 'runtime') {
          void fetchWorktrees(projectId, {
            executionHostId: toRuntimeExecutionHostId(resolved.authority.environmentId)
          })
        }
      }
      return
    }
    setEditingDestination(null)
    setDraft((current) => ({ ...current, projectId: '', workspaceId: '', baseBranch: '' }))
  }
  const editDestinationControl: AutomationCreateDestinationControl = {
    entries: editHostEntries,
    resolution: editHostResolution,
    onSelect: handleEditHostChange,
    projects: editHostProjects,
    moveWarning: editMoveTargetEntry
      ? translate(
          'auto.components.automations.createDestination.move',
          'Saving creates this automation on {host} and deletes the original and its run history.'
        ).replace('{host}', () => editMoveTargetEntry.authorityLabel)
      : null
  }
  const dialogRepos = isOrcaForm
    ? editingAutomationId !== null
      ? editHostProjects
      : editorProjects
    : getAutomationCreateRepos(repos, { kind: 'local' })

  // A destination change can strand the chosen project on another host; clear
  // it so the draft/default-target effect can select a project the host owns.
  useEffect(() => {
    if (!createOpen || editingAutomationId !== null || createTarget !== 'orca') {
      return
    }
    setDraft((current) =>
      !current.projectId || editorProjects.some((project) => project.id === current.projectId)
        ? current
        : { ...current, projectId: '', workspaceId: '', baseBranch: '' }
    )
  }, [createOpen, createTarget, editingAutomationId, editorProjects, setDraft])

  const dialogWorktrees = useMemo(() => {
    const candidates = worktreesByRepo[draft.projectId] ?? []
    const project = dialogRepos.find((repo) => repo.id === draft.projectId)
    if (!project) {
      return candidates
    }
    const hostId = getRepoExecutionHostId(project)
    const parsedHost = parseExecutionHostId(hostId)
    return candidates.filter((worktree) => {
      if (getWorktreeExecutionHostId(worktree, project) === hostId) {
        return true
      }
      return (
        parsedHost?.kind === 'runtime' &&
        worktree.runtimeOwnerEnvironmentId === parsedHost.environmentId
      )
    })
  }, [dialogRepos, draft.projectId, worktreesByRepo])
  const destinationForProject = useCallback(
    (projectId: string, hostStableKey?: string | null): AutomationCreateDestination | null => {
      const selectedEntry = hostStableKey
        ? hostCatalog.entries.find((candidate) => candidate.stableKey === hostStableKey)
        : null
      if (hostStableKey) {
        const selected = resolveAutomationCreateDestination(selectedEntry)
        return selected.status === 'ready' &&
          !automationCreateProjectMismatch(repoTables, selected, projectId)
          ? selected
          : null
      }
      const runContext = buildAutomationRunContextForRepo({
        repoId: projectId,
        repos,
        projectHostSetups
      })
      if (!runContext) {
        return null
      }
      const stableKey = automationCreateHostStableKey(runContext.hostId)
      const entry = stableKey
        ? hostCatalog.entries.find((candidate) => candidate.stableKey === stableKey)
        : undefined
      const resolved = resolveAutomationCreateDestination(entry)
      return resolved.status === 'ready' ? resolved : null
    },
    [hostCatalog.entries, projectHostSetups, repoTables, repos]
  )

  return {
    editingRow,
    editingRowCapturedOwner,
    automationDialogTarget,
    isOrcaForm,
    dialogAuthorityRepos,
    dialogAuthorityKey,
    editHostEntries,
    editHostResolution,
    editHostProjects,
    editMoveTargetEntry,
    editDestinationRuntimeEnvironmentId,
    handleEditHostChange,
    editDestinationControl,
    dialogRepos,
    dialogWorktrees,
    destinationForProject,
    projectHostSetups,
    settings
  }
}

export type AutomationsPageDestinationFormState = ReturnType<
  typeof useAutomationsPageDestinationForm
>
