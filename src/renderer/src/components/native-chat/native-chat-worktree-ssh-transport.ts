import type { AppState } from '../../store/types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'

type WorktreeSshTransportState = Pick<
  AppState,
  | 'detectedWorktreesByRepo'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'worktreesByRepo'
>

type WorktreeTransportOwner = {
  id: string
  repoId: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}

const NO_TRANSPORT_OWNERS: readonly WorktreeTransportOwner[] = []
const equivalentOwnerIndexCache = new WeakMap<
  object,
  ReadonlyMap<string, readonly WorktreeTransportOwner[]>
>()

export type NativeChatWorktreeSshTransportResolution =
  | { kind: 'resolved'; environmentId: string | null }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

export function resolveNativeChatWorktreeSshTransport(
  state: WorktreeSshTransportState,
  worktreeId: string,
  hostId: ExecutionHostId
): NativeChatWorktreeSshTransportResolution {
  const scope = parseWorkspaceKey(worktreeId)
  const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  const repoIds = new Set([getRepoIdFromWorktreeId(rawWorktreeId)])
  const environmentIds = new Set<string | null>()
  const owners = [
    ...findEquivalentOwners(state.worktreesByRepo, rawWorktreeId, () =>
      Object.values(state.worktreesByRepo ?? {})
    ),
    ...findEquivalentOwners(state.detectedWorktreesByRepo, rawWorktreeId, () =>
      Object.values(state.detectedWorktreesByRepo ?? {}).map((result) => result.worktrees)
    )
  ]
  let hasDirectOwner = false
  let hasRuntimeOwner = false
  for (const worktree of owners) {
    if (parseExecutionHostId(worktree.hostId)?.id !== hostId) {
      continue
    }
    repoIds.add(worktree.repoId)
    if (worktree.runtimeOwnerEnvironmentId?.trim()) {
      hasRuntimeOwner = true
    } else {
      hasDirectOwner = true
    }
    const resolution = resolveExactWorktreeRoute(state, worktree)
    if (resolution.kind === 'ambiguous') {
      return resolution
    }
    if (resolution.kind === 'resolved' && resolution.route.executionHostId === hostId) {
      environmentIds.add(resolution.route.runtimeEnvironmentId)
    }
  }
  if (hasDirectOwner && hasRuntimeOwner) {
    return { kind: 'ambiguous' }
  }
  if (environmentIds.size === 0) {
    for (const repo of state.repos) {
      if (!repoIds.has(repo.id)) {
        continue
      }
      const executionHost = parseExecutionHostId(repo.executionHostId)
      const connectionId = repo.connectionId?.trim()
      const connectionHostId = connectionId ? toSshExecutionHostId(connectionId) : null
      if (connectionHostId !== hostId && executionHost?.id !== hostId) {
        continue
      }
      environmentIds.add(executionHost?.kind === 'runtime' ? executionHost.environmentId : null)
    }
  }
  const restoredHostId =
    state.restoredRuntimeHostIdByWorkspaceSessionKey[rawWorktreeId] ??
    state.restoredRuntimeHostIdByWorkspaceSessionKey[worktreeId]
  if (restoredHostId) {
    const restoredHost = parseExecutionHostId(restoredHostId)
    if (restoredHost?.kind !== 'runtime') {
      return { kind: 'ambiguous' }
    }
    environmentIds.add(restoredHost.environmentId)
  }
  if (environmentIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  const environmentId = environmentIds.values().next().value
  return environmentIds.size === 1
    ? { kind: 'resolved', environmentId: environmentId ?? null }
    : { kind: 'missing' }
}

function findEquivalentOwners(
  catalog: object | undefined,
  worktreeId: string,
  ownerLists: () => Iterable<readonly WorktreeTransportOwner[]>
): readonly WorktreeTransportOwner[] {
  if (!catalog) {
    return NO_TRANSPORT_OWNERS
  }
  let index = equivalentOwnerIndexCache.get(catalog)
  if (!index) {
    const next = new Map<string, WorktreeTransportOwner[]>()
    for (const owners of ownerLists()) {
      for (const owner of owners) {
        const key = comparableWorktreeId(owner.id)
        const matches = next.get(key)
        if (matches) {
          matches.push(owner)
        } else {
          next.set(key, [owner])
        }
      }
    }
    index = next
    equivalentOwnerIndexCache.set(catalog, index)
  }
  return index.get(comparableWorktreeId(worktreeId)) ?? NO_TRANSPORT_OWNERS
}

function comparableWorktreeId(worktreeId: string): string {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  return parsed
    ? JSON.stringify([parsed.repoId, normalizeRuntimePathForComparison(parsed.worktreePath)])
    : worktreeId
}
