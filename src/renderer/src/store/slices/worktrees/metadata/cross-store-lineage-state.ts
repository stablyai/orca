import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { OWN_LINEAGE_STORE_KEY } from '../../../../../../shared/worktree/cross-store-lineage-resolution'

export type HostLineageList = {
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
  /** Saved as the host keeps them; read through validCrossStoreLineage. Older hosts omit them. */
  crossStoreLineageByChildKey?: Readonly<Record<string, unknown>>
  /** Reported by this desktop's own store only; a paired store's comes from its host descriptor. */
  installationId?: string
}

type CrossStoreLineageState = Pick<
  AppState,
  'crossStoreLineageByStoreKey' | 'ownLineageInstallationId'
>

/** Local lists cover this desktop's own store (SSH and WSL rows included); a paired server is its own. */
export function lineageStoreKeyOfTarget(target: RuntimeClientTarget): string {
  return target.kind === 'environment' ? target.environmentId : OWN_LINEAGE_STORE_KEY
}

/** Replaces one store's cross-store records whole: the child's store owns them, so its answer is complete. */
export function withStoreCrossStoreLineage(
  state: CrossStoreLineageState,
  storeKey: string,
  lineage: HostLineageList
): Partial<AppState> {
  const records = lineage.crossStoreLineageByChildKey ?? {}
  const current = state.crossStoreLineageByStoreKey[storeKey]
  const unchanged =
    current === records ||
    (Object.keys(records).length === 0 && Object.keys(current ?? {}).length === 0)
  const installationId =
    storeKey === OWN_LINEAGE_STORE_KEY ? lineage.installationId : state.ownLineageInstallationId
  return {
    ...(unchanged
      ? {}
      : {
          crossStoreLineageByStoreKey: { ...state.crossStoreLineageByStoreKey, [storeKey]: records }
        }),
    ...(installationId === state.ownLineageInstallationId
      ? {}
      : { ownLineageInstallationId: installationId })
  }
}

export function withoutChildCrossStoreLineage(
  state: CrossStoreLineageState,
  target: RuntimeClientTarget,
  worktreeId: string
): AppState['crossStoreLineageByStoreKey'] {
  const storeKey = lineageStoreKeyOfTarget(target)
  const childKey = worktreeWorkspaceKey(worktreeId)
  const records = state.crossStoreLineageByStoreKey[storeKey]
  if (!records || !Object.hasOwn(records, childKey)) {
    return state.crossStoreLineageByStoreKey
  }
  const { [childKey]: _cleared, ...rest } = records
  return { ...state.crossStoreLineageByStoreKey, [storeKey]: rest }
}
