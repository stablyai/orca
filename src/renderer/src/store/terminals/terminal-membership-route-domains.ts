import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'
import {
  createWorktreeCatalogQueryOwner,
  findIndexedWorktrees,
  findIndexedDetectedWorktrees
} from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { resolveTerminalPtyOwner, type TerminalPtyOwner } from '@/lib/terminal-worktree-route'
import { getSingleFocusedRuntimeEnvironmentId } from '@/lib/workspace/ownership/single-runtime-legacy-owner'
import { getPairedWebClientEnvironmentId } from '@/lib/paired-web-client-host'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { selectFolderWorkspaceCopies } from '../folder-workspaces/folder-workspace-record-index'
import type { TerminalTabRetirementState } from './terminal-tab-pty-ownership'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../shared/ephemeral-setup-terminal-worktree-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { readRecordChanges } from '../keyed-record-change-reads'

type State = TerminalTabRetirementState
function sameProjection(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, at) => value === b[at])
}

function changedIds<T extends { id: string }>(
  before: readonly T[] | undefined,
  after: readonly T[] | undefined,
  project: (row: T) => readonly unknown[]
): Set<string> {
  const collect = (rows: readonly T[] | undefined) => {
    const byId = new Map<string, unknown[]>()
    for (const row of rows ?? []) {
      const values = byId.get(row.id) ?? []
      values.push(...project(row))
      byId.set(row.id, values)
    }
    return byId
  }
  const old = collect(before),
    next = collect(after)
  const changed = new Set<string>()
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    if (!sameProjection(old.get(id) ?? [], next.get(id) ?? [])) {
      changed.add(id)
    }
  }
  return changed
}

export function createTerminalMembershipRouteDomains() {
  const catalogs = createWorktreeCatalogQueryOwner()
  const owners = new Map<string, TerminalPtyOwner>()
  const reposByWorkspace = new Map<string, Set<string>>()
  const workspacesByRepo = new Map<string, Set<string>>()
  const folders = new Map<string, string>()
  const workspacesByFolder = new Map<string, Set<string>>()
  const inferredFolders = new Set<string>()
  const setups = new Set<string>()
  const catalogFallback = new Set<string>()
  const web = isPairedWebClientWindow()

  function forget(workspace: string): void {
    owners.delete(workspace)
    for (const repo of reposByWorkspace.get(workspace) ?? []) {
      const dependents = workspacesByRepo.get(repo)
      dependents?.delete(workspace)
      if (!dependents?.size) {
        workspacesByRepo.delete(repo)
      }
    }
    reposByWorkspace.delete(workspace)
    const folderId = folders.get(workspace)
    if (folderId !== undefined) {
      const dependents = workspacesByFolder.get(folderId)
      dependents?.delete(workspace)
      if (!dependents?.size) {
        workspacesByFolder.delete(folderId)
      }
    }
    folders.delete(workspace)
    inferredFolders.delete(workspace)
    setups.delete(workspace)
    catalogFallback.delete(workspace)
  }

  function refresh(state: State, workspace: string): TerminalPtyOwner {
    forget(workspace)
    catalogs.known.ensure(selectWorktreesByRepo(state))
    catalogs.detected.ensure(selectDetectedWorktreesByRepo(state))
    const owner = resolveTerminalPtyOwner(state, workspace, 'spawn')
    owners.set(workspace, owner)
    const folder = parseWorkspaceKey(workspace)
    const setup = isEphemeralSetupTerminalWorktreeId(workspace)
    if (setup) {
      setups.add(workspace)
    } else if (folder?.type === 'folder') {
      folders.set(workspace, folder.folderWorkspaceId)
      const dependents = workspacesByFolder.get(folder.folderWorkspaceId) ?? new Set<string>()
      dependents.add(workspace)
      workspacesByFolder.set(folder.folderWorkspaceId, dependents)
      if (
        selectFolderWorkspaceCopies(state, folder.folderWorkspaceId).some(
          (row) => !parseExecutionHostId(row.executionHostId)
        )
      ) {
        inferredFolders.add(workspace)
      }
    } else if (workspace !== FLOATING_TERMINAL_WORKTREE_ID) {
      const repos = new Set([getRepoIdFromWorktreeId(workspace)])
      for (const row of [
        ...findIndexedWorktrees(selectWorktreesByRepo(state), workspace),
        ...findIndexedDetectedWorktrees(selectDetectedWorktreesByRepo(state), workspace)
      ]) {
        repos.add(row.repoId)
      }
      reposByWorkspace.set(workspace, repos)
      for (const repo of repos) {
        const dependents = workspacesByRepo.get(repo) ?? new Set<string>()
        dependents.add(workspace)
        workspacesByRepo.set(repo, dependents)
      }
    }
    if (web && workspace !== FLOATING_TERMINAL_WORKTREE_ID && !setup) {
      // Probe the existing resolver only when the sole server could be its fallback source.
      const withoutCatalog =
        owner.kind === 'runtime' && owner.environmentId === getPairedWebClientEnvironmentId(state)
          ? resolveTerminalPtyOwner({ ...state, runtimeEnvironments: [] }, workspace, 'spawn')
          : owner
      if (
        owner.kind !== 'runtime' ||
        withoutCatalog.kind !== 'runtime' ||
        withoutCatalog.environmentId !== owner.environmentId
      ) {
        catalogFallback.add(workspace)
      }
    }
    return owner
  }

  return {
    forget,
    owner(state: State, workspace: string): TerminalPtyOwner {
      return owners.get(workspace) ?? refresh(state, workspace)
    },
    accept(previous: State | null, state: State): ReadonlySet<string> {
      const affected = new Set<string>()
      for (const id of catalogs.known.accept(
        selectWorktreesByRepo(state),
        previous ? selectWorktreesByRepo(previous) : undefined
      )) {
        if (owners.has(id)) {
          affected.add(id)
        }
      }
      for (const id of catalogs.detected.accept(
        selectDetectedWorktreesByRepo(state),
        previous ? selectDetectedWorktreesByRepo(previous) : undefined
      )) {
        if (owners.has(id)) {
          affected.add(id)
        }
      }
      if (!previous) {
        return affected
      }
      const addAll = (ids: Iterable<string>) => {
        for (const id of ids) {
          affected.add(id)
        }
      }
      if (previous.repos !== state.repos) {
        const ids = changedIds(previous.repos, state.repos, (r) => [
          r.executionHostId,
          r.connectionId,
          r.path,
          r.projectGroupId
        ])
        for (const id of ids) {
          addAll(workspacesByRepo.get(id) ?? [])
        }
        if (ids.size) {
          addAll(inferredFolders)
        }
        if ((previous.repos === undefined) !== (state.repos === undefined)) {
          addAll(reposByWorkspace.keys())
          addAll(folders.keys())
        }
      }
      if (selectFolderWorkspaces(previous) !== selectFolderWorkspaces(state)) {
        const ids = changedIds(
          selectFolderWorkspaces(previous),
          selectFolderWorkspaces(state),
          (r) => [r.projectGroupId, r.connectionId, r.executionHostId, r.folderPath]
        )
        for (const id of ids) {
          addAll(workspacesByFolder.get(id) ?? [])
        }
      }
      if (previous.projectGroups !== state.projectGroups) {
        const ids = changedIds(previous.projectGroups, state.projectGroups, (r) => [
          r.parentGroupId,
          r.executionHostId,
          r.connectionId
        ])
        if (ids.size) {
          addAll(inferredFolders)
        }
        if ((previous.projectGroups === undefined) !== (state.projectGroups === undefined)) {
          addAll(folders.keys())
        }
      }
      if (
        previous.activeWorktreeId !== state.activeWorktreeId ||
        previous.activeWorkspaceExecutionHostId !== state.activeWorkspaceExecutionHostId
      ) {
        for (const id of [previous.activeWorktreeId, state.activeWorktreeId]) {
          if (id && owners.has(id)) {
            affected.add(id)
          }
        }
      }
      if (
        previous.restoredRuntimeHostIdByWorkspaceSessionKey !==
        state.restoredRuntimeHostIdByWorkspaceSessionKey
      ) {
        const before = previous.restoredRuntimeHostIdByWorkspaceSessionKey ?? {},
          after = state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {}
        const change = readRecordChanges(after, before)
        for (const id of change?.kind === 'addressed'
          ? change.keys
          : new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (before[id] !== after[id] && owners.has(id)) {
            affected.add(id)
          }
        }
      }
      if (
        previous.settings !== state.settings ||
        previous.runtimeEnvironments !== state.runtimeEnvironments
      ) {
        if (
          getSingleFocusedRuntimeEnvironmentId(previous) !==
          getSingleFocusedRuntimeEnvironmentId(state)
        ) {
          addAll(setups)
        }
      }
      if (
        web &&
        (previous.runtimeEnvironments !== state.runtimeEnvironments ||
          previous.runtimeEnvironmentCatalogHydrated !== state.runtimeEnvironmentCatalogHydrated)
      ) {
        if (
          getPairedWebClientEnvironmentId(previous) !== getPairedWebClientEnvironmentId(state) ||
          (previous.runtimeEnvironments === undefined) !==
            (state.runtimeEnvironments === undefined) ||
          previous.runtimeEnvironmentCatalogHydrated !== state.runtimeEnvironmentCatalogHydrated
        ) {
          addAll(catalogFallback)
        }
      }
      for (const id of affected) {
        refresh(state, id)
      }
      return affected
    }
  }
}
