import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { reuseEqualRecordMap } from '../../../../lib/catalog-reconciliation/catalog-record-reconciliation'
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

/** The child's store owns its records, so its answer replaces that store's whole; as for the
 * other lineage maps, a child written since the request started keeps its current record. */
export function withStoreCrossStoreLineage(
  state: CrossStoreLineageState,
  storeKey: string,
  lineage: HostLineageList,
  requestStart?: Partial<CrossStoreLineageState>
): Partial<AppState> {
  const current = state.crossStoreLineageByStoreKey[storeKey] ?? {}
  const atRequestStart = requestStart?.crossStoreLineageByStoreKey
  const before = atRequestStart?.[storeKey] ?? {}
  const writtenSinceRequestStart = (childKey: string): boolean =>
    atRequestStart !== undefined && before[childKey] !== current[childKey]
  const next: Record<string, unknown> = {}
  for (const [childKey, record] of Object.entries(current)) {
    if (writtenSinceRequestStart(childKey)) {
      next[childKey] = record
    }
  }
  for (const [childKey, record] of Object.entries(lineage.crossStoreLineageByChildKey ?? {})) {
    if (!writtenSinceRequestStart(childKey)) {
      next[childKey] = record
    }
  }
  const merged = reuseEqualRecordMap(current, next)
  const installationId =
    storeKey === OWN_LINEAGE_STORE_KEY ? lineage.installationId : state.ownLineageInstallationId
  return {
    ...(merged === current
      ? {}
      : {
          crossStoreLineageByStoreKey: { ...state.crossStoreLineageByStoreKey, [storeKey]: merged }
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
