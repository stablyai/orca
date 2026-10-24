import { useAppStore } from '@/store'
import { getLineageInputs, requireCurrentLineageRow } from './visible-worktree-indexes'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  findWorktreeLineageRow,
  getWorktreeLineageSelection,
  type WorktreeLineageIdentity
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import { lineageStoreKeyForRow } from '../../../../shared/resolved-worktree-lineage'
import type { AppState } from '@/store/types'
import type { ConfirmedUnsavedDiscards } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import type { Worktree } from '../../../../shared/worktree/types'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'

export type WorktreeBatchDeleteOptions = {
  forceConfirm?: boolean
  forceOnConfirm?: boolean
  onDeleted?: (targets: WorktreeRemovalTarget[]) => void
}

/** `hostId` rides along because `id` alone repeats across hosts (STA-4343). */
export type WorktreeDeleteIdentity = Pick<Worktree, 'id' | 'instanceId' | 'hostId'> & {
  storeKey?: string
}

export type WorktreeDeleteOptions = {
  expectedIdentity?: WorktreeDeleteIdentity
  expectedInstanceId?: string
  /** Why (STA-4343): the id-keyed map holds one row per `repoId::path`, so a row
   *  that knows its host must say so or the delete lands on the other one. */
  expectedHostId?: ExecutionHostId
}

export type WorktreeDeleteWithToastOptions = {
  force?: boolean
  onForceDeleted?: (target: WorktreeRemovalTarget) => void
  onPreservedBranch?: (branch: PreservedBranchCleanup) => void
  suppressPreservedBranchToast?: boolean
  assertBeforeDispatch?: () => void
  snapshotPruneBatchId?: string
  confirmedDiscards?: ConfirmedUnsavedDiscards
}

export function toWorktreeDeleteIdentities(
  worktrees: readonly WorktreeLineageIdentity[]
): WorktreeDeleteIdentity[] {
  return worktrees.map((row) => ({
    id: row.id,
    instanceId: row.instanceId,
    hostId: row.hostId,
    storeKey: lineageStoreKeyForRow(row)
  }))
}

/** Resolves one confirmed row: the id ALONE is not enough, so the host rides along. */
export type WorktreeDeleteTargetLookup = (
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  identity?: WorktreeDeleteIdentity
) => Worktree | undefined

export function getRegisteredWorktreeDeleteTarget(
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>,
  id: string,
  hostId: ExecutionHostId | undefined,
  identity?: WorktreeDeleteIdentity
): Worktree | undefined {
  const rows = getLineageInputs(state).worktreeMap
  const selection =
    identity?.storeKey !== undefined
      ? JSON.stringify([identity.storeKey, hostId ?? null, id, identity.instanceId ?? null])
      : hostId
        ? composeWorktreeHostIdentity(hostId, id)
        : id
  return findWorktreeLineageRow(rows, selection)
}

export function createWorktreeDeleteAdmission(target: WorktreeLineageIdentity): () => void {
  const selection = getWorktreeLineageSelection(target)
  return () => {
    requireCurrentLineageRow(useAppStore.getState(), selection)
  }
}

export function resolveWorktreeBatchDeleteTargets(
  requestedWorktrees: readonly string[] | readonly WorktreeDeleteIdentity[],
  lookupTarget: WorktreeDeleteTargetLookup
): Worktree[] | null {
  // Why (STA-4343): dedup on (id, host), not id — two hosts can publish the same
  // `repoId::path`, and collapsing them here would silently drop one confirmed row.
  const uniqueRequests = Array.from(
    new Map(
      requestedWorktrees.map((request) => {
        const key =
          typeof request === 'string'
            ? request
            : JSON.stringify([request.storeKey, request.hostId, request.id, request.instanceId])
        return [key, request] as const
      })
    ).values()
  )
  const targets: Worktree[] = []
  for (const request of uniqueRequests) {
    const worktreeId = typeof request === 'string' ? request : request.id
    // A request that names a host resolves on THAT host, so confirming a remote
    // row can never fall through to a local checkout at the same path — and the
    // other host's row stays reachable instead of being masked by the id-keyed map.
    const target =
      lookupTarget(
        worktreeId,
        typeof request === 'string' ? undefined : request.hostId,
        typeof request === 'string' ? undefined : request
      ) ?? null
    if (typeof request !== 'string' && (!target || target.instanceId !== request.instanceId)) {
      return null
    }
    if (target && !target.isMainWorktree) {
      targets.push(target)
    }
  }
  return targets
}

export function readWorktreeDeleteIdentities(value: unknown): WorktreeDeleteIdentity[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') {
      return []
    }
    const instanceId = 'instanceId' in entry ? entry.instanceId : undefined
    if (instanceId !== undefined && typeof instanceId !== 'string') {
      return []
    }
    const hostId = normalizeExecutionHostId(
      'hostId' in entry && typeof entry.hostId === 'string' ? entry.hostId : null
    )
    const storeKey = 'storeKey' in entry ? entry.storeKey : undefined
    if (storeKey !== undefined && typeof storeKey !== 'string') {
      return []
    }
    return [
      {
        id: entry.id,
        instanceId,
        ...(hostId ? { hostId } : {}),
        ...(storeKey !== undefined ? { storeKey } : {})
      }
    ]
  })
}
