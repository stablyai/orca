import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoCatalogOwnerHostId } from '../store/projects/project-catalog-owner'
import {
  findIndexedWorktreesById,
  findIndexedReposById,
  findIndexedDetectedWorktrees
} from './worktree-runtime-owner-index'

export type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
export type WorktreeSelectionRow = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId' | 'identity' | 'instanceId'
>
export type WorktreeSelectionRepo = Pick<
  Repo,
  'id' | 'executionHostId' | 'connectionId' | 'catalogOwnerHostId' | 'authoritativeExecutionHostId'
>

export function worktreeSelectionOwnerKey(
  owner: WorktreeSelectionOwner | null | undefined
): string {
  return owner
    ? JSON.stringify([
        owner.worktreeId,
        owner.publisherHostId,
        owner.executionHostId,
        owner.instanceId ?? null
      ])
    : ''
}

export function worktreeSelectionOwnerForRow(
  row: WorktreeSelectionRow,
  repos: readonly WorktreeSelectionRepo[] | undefined
): WorktreeSelectionOwner | null {
  if (row.identity && row.instanceId && row.identity.instanceId !== row.instanceId) {
    return null
  }
  const rawHost = row.identity?.executionHostId ?? row.hostId ?? 'local'
  const pairedPublisher = row.runtimeOwnerEnvironmentId?.trim()
  const displayHost = parseExecutionHostId(row.hostId)
  if (
    !parseExecutionHostId(rawHost) ||
    (row.identity &&
      displayHost &&
      displayHost.id !== rawHost &&
      displayHost.id !== (pairedPublisher ? toRuntimeExecutionHostId(pairedPublisher) : undefined))
  ) {
    return null
  }
  const publishers = pairedPublisher
    ? null
    : new Set(
        findIndexedReposById(repos, row.repoId)
          .filter(
            (repo) =>
              (repo.authoritativeExecutionHostId ?? getRepoExecutionHostId(repo)) === rawHost
          )
          .map(getRepoCatalogOwnerHostId)
      )
  if (publishers && publishers.size > 1) {
    return null
  }
  const publisher = pairedPublisher
    ? toRuntimeExecutionHostId(pairedPublisher)
    : publishers?.size === 1
      ? publishers.values().next().value
      : parseExecutionHostId(rawHost)?.kind !== 'runtime'
        ? 'local'
        : undefined
  const publisherHostId = parseExecutionHostId(publisher)?.id
  if (!publisherHostId) {
    return null
  }
  return {
    worktreeId: row.id,
    executionHostId: rawHost,
    publisherHostId,
    ...((row.identity?.instanceId ?? row.instanceId)
      ? { instanceId: row.identity?.instanceId ?? row.instanceId }
      : {})
  }
}

type WorktreeSelectionState<T extends WorktreeSelectionRow = WorktreeSelectionRow> = {
  repos?: readonly WorktreeSelectionRepo[]
  worktreesByRepo?: Record<string, readonly T[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly T[] }>
  activeWorktreeId?: string | null
  activeWorkspaceOwner?: WorktreeSelectionOwner | null
}

export function findWorktreeForSelectionOwner<T extends WorktreeSelectionRow>(
  state: WorktreeSelectionState<T>,
  owner: WorktreeSelectionOwner
): T | null {
  let selected: T | null = null
  let selectedKey: string | undefined
  const catalogs = [
    findIndexedWorktreesById(state.worktreesByRepo, owner.worktreeId),
    findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, owner.worktreeId)
  ]
  for (const rows of catalogs) {
    let matches = 0
    for (const row of rows) {
      if (row.id !== owner.worktreeId) {
        continue
      }
      const current = worktreeSelectionOwnerForRow(row, state.repos)
      if (
        !current ||
        current.publisherHostId !== owner.publisherHostId ||
        current.executionHostId !== owner.executionHostId
      ) {
        continue
      }
      if (++matches > 1) {
        return null
      }
      const key = worktreeSelectionOwnerKey(current)
      if (selectedKey !== undefined && selectedKey !== key) {
        return null
      }
      selectedKey = key
      if (owner.instanceId === undefined || current.instanceId === owner.instanceId) {
        selected ??= row
      }
    }
  }
  return selected
}

export function getActiveWorktreeOwner(
  state: { activeWorktreeId?: string | null; activeWorkspaceOwner?: WorktreeSelectionOwner | null },
  worktreeId: string | null,
  executionHostId?: ExecutionHostId
): WorktreeSelectionOwner | undefined {
  return !executionHostId &&
    state.activeWorktreeId === worktreeId &&
    state.activeWorkspaceOwner?.worktreeId === worktreeId
    ? state.activeWorkspaceOwner
    : undefined
}

export function withAvailableWorktreeSelectionInstance(
  owner: WorktreeSelectionOwner | undefined,
  row: WorktreeSelectionRow | undefined
): WorktreeSelectionOwner | undefined {
  const instanceId = row?.identity?.instanceId ?? row?.instanceId
  return owner && owner.instanceId === undefined && instanceId ? { ...owner, instanceId } : owner
}

export function isCurrentWorktreeSelection(
  state: WorktreeSelectionState,
  worktreeId: string,
  owner: WorktreeSelectionOwner | undefined
): boolean {
  return (
    state.activeWorktreeId === worktreeId &&
    worktreeSelectionOwnerKey(state.activeWorkspaceOwner) === worktreeSelectionOwnerKey(owner) &&
    (!owner || findWorktreeForSelectionOwner(state, owner) !== null)
  )
}
