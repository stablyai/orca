import { AUTOMATION_ORPHAN_ISSUES } from '../../../../shared/automation-list-scope'
import {
  recordedAutomationRunContext,
  isSameAutomationWorkspace
} from './automation-recorded-target'
import { useCallback, useEffect, useMemo } from 'react'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { automationWorktreesForRepo } from './automation-list-row-identity'
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
    editingAutomationId,
    editingRowKey,
    editingHostStableKey,
    setEditingHostStableKey,
    setEditingDestination,
    setTargetEdited,
    setDraft,
    draft,
    draftRef
  } = local
  const { visibleRows, hostCatalog, capturedAutomationOwners } = list
  const { automationHostTarget, automationHostTargetForRowKey, repoTables, editorProjects } = base
  const editingRow = editingRowKey
    ? (visibleRows.find((row) => row.key === editingRowKey) ?? null)
    : null
  const captured = capturedAutomationOwner(capturedAutomationOwners, editingRowKey)
  const editingRowCapturedOwner: AutomationCapturedOwner['owner'] = capturedAutomationOwner(
    capturedAutomationOwners,
    editingRowKey
  ).owner
  const automationDialogTarget: AutomationHostTarget = (() => {
    if (editingAutomationId === null) {
      return getAutomationListTarget(settings)
    }
    if (captured.authority) {
      return getAutomationAuthorityTarget(captured.authority)
    }
    if (editingRow && !editingRowCapturedOwner) {
      return getAutomationOwnerTarget(editingRow.automation, automationHostTarget)
    }
    return (
      automationHostTargetForRowKey(editingRowKey) ??
      getAutomationTargetFromHostId(editingRow?.automation.runContext?.hostId)
    )
  })()
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
  const recordedAutomation =
    captured.selector?.kind === 'orphan' &&
    captured.selector.issue === AUTOMATION_ORPHAN_ISSUES.hostReselection &&
    editingRow?.automation.runContext
      ? editingRow.automation
      : null
  const recordedTargetSelected = !!(
    recordedAutomation &&
    isSameAutomationWorkspace(recordedAutomation, draft) &&
    editHostResolution.status === 'ready' &&
    recordedAutomationRunContext(recordedAutomation, captured, editHostResolution)
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
    setTargetEdited(true)
    setEditingHostStableKey(stableKey)
    const resolved = resolveAutomationCreateDestination(
      editHostEntries.find((entry) => entry.stableKey === stableKey)
    )
    const projectId = draftRef.current.projectId
    if (
      recordedAutomation &&
      isSameAutomationWorkspace(recordedAutomation, draftRef.current) &&
      resolved.status === 'ready' &&
      recordedAutomationRunContext(recordedAutomation, captured, resolved)
    ) {
      setEditingDestination({ projectId, destination: resolved })
      return
    }
    if (
      projectId &&
      resolved.status === 'ready' &&
      !automationCreateProjectMismatch(repoTables, resolved, projectId)
    ) {
      setEditingDestination({ projectId, destination: resolved })
      if (editingHostStableKey !== null && editingHostStableKey !== stableKey) {
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
    recordedProject:
      recordedAutomation && (!editingHostStableKey || recordedTargetSelected)
        ? { id: recordedAutomation.projectId, label: recordedAutomation.runContext!.path }
        : undefined,
    moveWarning: editMoveTargetEntry
      ? translate(
          'auto.components.automations.createDestination.move',
          'Saving creates this automation on {host} and deletes the original and its run history.'
        ).replace('{host}', () => editMoveTargetEntry.authorityLabel)
      : null
  }
  const dialogRepos = editingAutomationId !== null ? editHostProjects : editorProjects

  // Clear projects stranded by destination changes so defaults can select one the chosen host owns.
  useEffect(() => {
    if (!createOpen || editingAutomationId !== null) {
      return
    }
    setDraft((current) =>
      !current.projectId || editorProjects.some((project) => project.id === current.projectId)
        ? current
        : { ...current, projectId: '', workspaceId: '', baseBranch: '' }
    )
  }, [createOpen, editingAutomationId, editorProjects, setDraft])

  const dialogWorktrees = useMemo(() => {
    const candidates = worktreesByRepo[draft.projectId] ?? []
    const project = dialogRepos.find((repo) => repo.id === draft.projectId)
    return project ? automationWorktreesForRepo(candidates, project, repos) : []
  }, [dialogRepos, draft.projectId, repos, worktreesByRepo])
  const destinationForProject = useCallback(
    (projectId: string, hostStableKey?: string | null): AutomationCreateDestination | null => {
      const selectedEntry = hostStableKey
        ? hostCatalog.entries.find((candidate) => candidate.stableKey === hostStableKey)
        : null
      if (hostStableKey) {
        const selected = resolveAutomationCreateDestination(selectedEntry)
        return selected.status === 'ready' &&
          (!automationCreateProjectMismatch(repoTables, selected, projectId) ||
            (recordedAutomation?.projectId === projectId &&
              !!recordedAutomationRunContext(recordedAutomation, captured, selected)))
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
    [hostCatalog.entries, projectHostSetups, repoTables, repos, recordedAutomation, captured]
  )

  return {
    editingRow,
    recordedTargetSelected,
    editingRowCapturedOwner,
    automationDialogTarget,
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
