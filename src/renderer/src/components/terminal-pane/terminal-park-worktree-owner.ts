/**
 * Resolves the transport owner a worktree's own terminals spawn against, for the
 * park predicate to compare a remote pty id's embedded owner with.
 *
 * Why separate from terminal-park-pty-restore-eligibility: that module stays a
 * pure predicate over ids, with no store dependency.
 */
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  resolveExplicitWorktreeOperationRouteResult,
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRoute,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { useAppStore } from '@/store'
import type { TerminalParkWorktreeOwner } from './terminal-park-pty-restore-eligibility'

export type TerminalParkWorktreeOwnerState = WorktreeOperationRouteState

const UNKNOWN_OWNER: TerminalParkWorktreeOwner = { kind: 'unknown' }
const AMBIGUOUS_OWNER: TerminalParkWorktreeOwner = { kind: 'ambiguous' }

function ownerFromRoute(route: WorktreeOperationRoute): TerminalParkWorktreeOwner {
  if (route.runtimeEnvironmentId) {
    return { kind: 'runtime', environmentId: route.runtimeEnvironmentId }
  }
  const host = parseExecutionHostId(route.executionHostId)
  if (host?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: host.environmentId }
  }
  if (host?.kind === 'ssh') {
    return { kind: 'ssh', connectionId: host.targetId }
  }
  return host?.kind === 'local' ? { kind: 'local' } : UNKNOWN_OWNER
}

function ownerKey(owner: TerminalParkWorktreeOwner): string {
  return JSON.stringify(owner)
}

function resolveFolderOwner(
  state: TerminalParkWorktreeOwnerState,
  worktreeId: string,
  folderWorkspaceId: string
): TerminalParkWorktreeOwner {
  const workspaces = (state.folderWorkspaces ?? []).filter(
    (workspace) => workspace.id === folderWorkspaceId
  )
  if (workspaces.length === 0) {
    return UNKNOWN_OWNER
  }
  const owners = new Map<string, TerminalParkWorktreeOwner>()
  let unresolvedRecords = 0
  for (const workspace of workspaces) {
    const groups = (state.projectGroups ?? []).filter(
      (group) => group.id === workspace.projectGroupId
    )
    const candidates = groups.length > 0 ? groups : [null]
    let recordResolved = false
    for (const group of candidates) {
      const host = parseExecutionHostId(workspace.executionHostId ?? group?.executionHostId)
      const connectionId = workspace.connectionId?.trim() || group?.connectionId?.trim()
      const owner = host
        ? ownerFromRoute({
            executionHostId: host.id,
            runtimeEnvironmentId: host.kind === 'runtime' ? host.environmentId : null
          })
        : connectionId
          ? ({ kind: 'ssh', connectionId } as const)
          : null
      if (owner) {
        owners.set(ownerKey(owner), owner)
        recordResolved = true
      }
    }
    if (!recordResolved) {
      unresolvedRecords += 1
    }
  }
  const restoredHost = parseExecutionHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[worktreeId]
  )
  if (restoredHost?.kind === 'runtime') {
    const owner = { kind: 'runtime', environmentId: restoredHost.environmentId } as const
    owners.set(ownerKey(owner), owner)
    unresolvedRecords = 0
  }
  if (state.activeWorktreeId === worktreeId) {
    const activeHost = parseExecutionHostId(state.activeWorkspaceExecutionHostId)
    if (activeHost) {
      const owner = ownerFromRoute({
        executionHostId: activeHost.id,
        runtimeEnvironmentId: activeHost.kind === 'runtime' ? activeHost.environmentId : null
      })
      owners.set(ownerKey(owner), owner)
      unresolvedRecords = 0
    }
  }
  if (owners.size > 1 || (owners.size > 0 && unresolvedRecords > 0)) {
    return AMBIGUOUS_OWNER
  }
  const explicitOwner = owners.values().next().value
  if (explicitOwner) {
    return explicitOwner
  }
  if (state.runtimeEnvironmentCatalogHydrated !== true) {
    return UNKNOWN_OWNER
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved'
    ? ownerFromRoute(resolution.route)
    : resolution.kind === 'ambiguous'
      ? AMBIGUOUS_OWNER
      : UNKNOWN_OWNER
}

export function getTerminalParkWorktreeOwner(
  state: TerminalParkWorktreeOwnerState,
  worktreeId: string | null
): TerminalParkWorktreeOwner {
  if (!worktreeId) {
    return UNKNOWN_OWNER
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return { kind: 'local' }
  }
  const workspace = parseWorkspaceKey(worktreeId)
  if (workspace?.type === 'folder') {
    return resolveFolderOwner(state, worktreeId, workspace.folderWorkspaceId)
  }
  const explicit = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (explicit.kind === 'ambiguous') {
    return AMBIGUOUS_OWNER
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind === 'ambiguous') {
    return AMBIGUOUS_OWNER
  }
  return resolution.kind === 'resolved' ? ownerFromRoute(resolution.route) : UNKNOWN_OWNER
}

/** Why subscribed: ownership hydrates after the tabs do; memoized so it can key effects. */
export function useTerminalParkWorktreeOwner(worktreeId: string | null): TerminalParkWorktreeOwner {
  const state = useTerminalParkWorktreeOwnerState()
  return useMemo(() => getTerminalParkWorktreeOwner(state, worktreeId), [state, worktreeId])
}

/** Subscribes a many-worktree parking pass to every transport-owner authority slice. */
export function useTerminalParkWorktreeOwnerState(): TerminalParkWorktreeOwnerState {
  return useAppStore(
    useShallow((state) => ({
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
      activeWorktreeId: state.activeWorktreeId,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
      repos: state.repos,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      runtimeEnvironments: state.runtimeEnvironments,
      settings: state.settings,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
}
