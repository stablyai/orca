import { useCallback, useEffect, useMemo } from 'react'
import type {
  AutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import {
  getWorktreeExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import {
  automationCreateHostOffered,
  automationCreateHostStableKey
} from './automation-create-destination'
import { getAutomationHostTargetFromKey, type AutomationHostTarget } from './automation-host-client'
import {
  capturedAutomationOwner,
  isAutomationActionEnabled,
  type AutomationRowAction
} from './automation-captured-owner'
import {
  automationRowCatalogRef,
  automationWriteChangeEvent
} from './automation-write-invalidation'
import { automationRowRecoveryHost } from './automation-notice-recovery-host'
import type {
  AutomationActionNotice,
  AutomationDispatchContext
} from './automation-row-action-dispatch'
import {
  automationRuntimePairingRevision,
  groupReposByAutomationAuthority
} from './automation-authority-identity'
import { getDefaultWorktree } from './automation-draft-model'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'
import { useAutomationCreateDestination } from './use-automation-create-destination'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationAuthorityChangeReason } from './automation-host-invalidation'

/** Host destination, owner fencing, and authority-scoped project/workspace choices. */
export function useAutomationsPageDestinationState({
  store,
  local,
  list
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
}) {
  const {
    repos,
    worktreesByRepo,
    activeWorktreeId,
    repoMap,
    worktreeMap,
    runtimeEnvironments,
    fetchRuntimeEnvironmentRepos
  } = store
  const { createOpen, createTarget, editingAutomationId, editingRowKey, setOwnerAction } = local
  const { hostCatalog, capturedAutomationOwners } = list

  const automationHostTarget = useMemo(
    () => getAutomationHostTargetFromKey(local.automationHostTargetKey),
    [local.automationHostTargetKey]
  )
  const automationAuthority = useMemo((): AutomationAuthorityRef => {
    const selectedAuthority = hostCatalog.resolution.entry?.stableRef.authority
    if (selectedAuthority?.kind !== 'runtime') {
      return { kind: 'desktop' }
    }
    const environmentId = selectedAuthority.environmentId
    return {
      kind: 'runtime',
      environmentId,
      pairingRevision: automationRuntimePairingRevision(runtimeEnvironments, environmentId)
    }
  }, [hostCatalog.resolution.entry, runtimeEnvironments])
  const repoTables = useMemo(() => groupReposByAutomationAuthority(repos), [repos])
  const activeWorkspaceHostStableKey = useMemo(() => {
    const worktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
    return worktree
      ? automationCreateHostStableKey(
          getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId))
        )
      : null
  }, [activeWorktreeId, repoMap, worktreeMap])
  const createDestination = useAutomationCreateDestination({
    open: createOpen && editingAutomationId === null && createTarget === 'orca',
    catalog: hostCatalog.catalog,
    entries: hostCatalog.entries,
    filterStableKey: hostCatalog.resolution.entry?.stableKey ?? null,
    activeWorkspaceStableKey: activeWorkspaceHostStableKey,
    repoTables,
    projects: repos
  })
  const editorProjects = createDestination.control.projects
  const createDestinationRuntimeEnvironmentId =
    createDestination.control.resolution.status === 'ready' &&
    createDestination.control.resolution.authority.kind === 'runtime'
      ? createDestination.control.resolution.authority.environmentId
      : null
  const createDestinationHostId = createDestinationRuntimeEnvironmentId
    ? toRuntimeExecutionHostId(createDestinationRuntimeEnvironmentId)
    : undefined
  useEffect(() => {
    if (createDestinationRuntimeEnvironmentId) {
      void fetchRuntimeEnvironmentRepos(createDestinationRuntimeEnvironmentId)
    }
  }, [createDestinationRuntimeEnvironmentId, fetchRuntimeEnvironmentRepos])

  const automationHostTargetForRowKey = useCallback(
    (rowKey: string | null): AutomationHostTarget | null => {
      const owner = capturedAutomationOwner(capturedAutomationOwners, rowKey).owner
      if (owner?.authority.kind === 'runtime') {
        return { kind: 'environment', environmentId: owner.authority.environmentId }
      }
      return owner ? { kind: 'local' } : automationHostTarget
    },
    [automationHostTarget, capturedAutomationOwners]
  )
  const automationHostTargetFor = useCallback(
    (row: { key: string }): AutomationHostTarget | null => automationHostTargetForRowKey(row.key),
    [automationHostTargetForRowKey]
  )
  const automationAuthorityForRow = useCallback(
    (row: { catalogRef?: StableAutomationCatalogRef | null }): AutomationAuthorityRef => {
      const authority = row.catalogRef?.authority
      if (authority?.kind === 'runtime') {
        return {
          kind: 'runtime',
          environmentId: authority.environmentId,
          pairingRevision: automationRuntimePairingRevision(
            runtimeEnvironments,
            authority.environmentId
          )
        }
      }
      return { kind: 'desktop' }
    },
    [runtimeEnvironments]
  )
  const automationDispatchContext = useMemo<AutomationDispatchContext>(
    () => ({ capturedOwners: capturedAutomationOwners, authority: automationAuthority }),
    [automationAuthority, capturedAutomationOwners]
  )
  const rowRecoveryHost = useCallback(
    (rowKey: string | null): AutomationHostCatalogEntry | null =>
      automationRowRecoveryHost(
        hostCatalog.catalog,
        capturedAutomationOwner(capturedAutomationOwners, rowKey),
        automationAuthority
      ),
    [automationAuthority, capturedAutomationOwners, hostCatalog.catalog]
  )
  const reportOwnerAction = useCallback(
    (rowKey: string | null, notice: AutomationActionNotice | null): void => {
      setOwnerAction(notice ? { notice, host: rowRecoveryHost(rowKey) } : null)
    },
    [rowRecoveryHost, setOwnerAction]
  )
  const editorRecoveryHost = useMemo((): AutomationHostCatalogEntry | null => {
    if (editingAutomationId !== null) {
      return rowRecoveryHost(editingRowKey)
    }
    const resolution = createDestination.control.resolution
    return resolution.status === 'ready' ? resolution.entry : null
  }, [createDestination.control.resolution, editingAutomationId, editingRowKey, rowRecoveryHost])
  const notifyAuthorityChange = hostCatalog.notifyAuthorityChange
  const invalidateWrittenHost = useCallback(
    (ref: StableAutomationCatalogRef | null, reason: AutomationAuthorityChangeReason): void => {
      notifyAuthorityChange(automationWriteChangeEvent(ref, automationAuthority, reason))
    },
    [automationAuthority, notifyAuthorityChange]
  )
  const invalidateRowHost = useCallback(
    (rowKey: string | null, reason: AutomationAuthorityChangeReason): void => {
      const captured = capturedAutomationOwner(capturedAutomationOwners, rowKey)
      invalidateWrittenHost(automationRowCatalogRef(captured, automationAuthority), reason)
    },
    [automationAuthority, capturedAutomationOwners, invalidateWrittenHost]
  )
  const isAutomationRowActionEnabled = useCallback(
    (row: { key: string }, action: AutomationRowAction): boolean =>
      isAutomationActionEnabled(capturedAutomationOwner(capturedAutomationOwners, row.key), action),
    [capturedAutomationOwners]
  )

  const getDefaultTarget = useCallback(() => {
    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
    const activeRepo = activeWorktree ? (repoMap.get(activeWorktree.repoId) ?? null) : null
    const eligibleActiveRepo =
      activeRepo && editorProjects.some((project) => project.id === activeRepo.id)
        ? activeRepo
        : null
    const fallbackRepo = eligibleActiveRepo ?? editorProjects[0] ?? null
    const fallbackWorktrees = fallbackRepo ? (worktreesByRepo[fallbackRepo.id] ?? []) : []
    const targetWorktree =
      getDefaultWorktree(fallbackWorktrees) ??
      (activeWorktree && activeWorktree.repoId === fallbackRepo?.id ? activeWorktree : null)
    return {
      projectId: fallbackRepo?.id ?? targetWorktree?.repoId ?? '',
      workspaceId: targetWorktree?.id ?? ''
    }
  }, [activeWorktreeId, editorProjects, repoMap, worktreeMap, worktreesByRepo])

  return {
    automationHostTarget,
    automationAuthority,
    repoTables,
    activeWorkspaceHostStableKey,
    createDestination,
    editorProjects,
    createDestinationRuntimeEnvironmentId,
    createDestinationHostId,
    automationHostTargetForRowKey,
    automationHostTargetFor,
    automationAuthorityForRow,
    automationDispatchContext,
    rowRecoveryHost,
    reportOwnerAction,
    editorRecoveryHost,
    invalidateWrittenHost,
    invalidateRowHost,
    isAutomationRowActionEnabled,
    getDefaultTarget,
    canCreateAutomation: hostCatalog.entries.some(automationCreateHostOffered),
    setOwnerAction
  }
}

export type AutomationsPageDestinationState = ReturnType<typeof useAutomationsPageDestinationState>
