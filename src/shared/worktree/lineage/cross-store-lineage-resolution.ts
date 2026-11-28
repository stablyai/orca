import { parseExecutionHostId } from '../../execution-host/execution-host'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../../remote-runtime/host-status/runtime-host-status'
import type { WorkspaceKey } from '../../workspace/identity/workspace-scope'
import { isCrossStoreWorkspaceLineage, validCrossStoreLineage } from './cross-store-lineage-records'
import { lineageInstanceIdOfRow, workspaceKeyOfRow } from './lineage-row-identity'
import type { Worktree } from '../types'

/** The viewer's own store; other stores are keyed by their paired runtime environment id. */
export const OWN_LINEAGE_STORE_KEY = ''

/** One Orca store as the viewer sees it: its installationId (identity) and its saved cross-store records. */
export type LineageStoreView = {
  installationId: string | undefined
  crossStoreLineageByChildKey: Readonly<Record<string, unknown>> | undefined
}

/** Every store the viewer can see, by store key. Store keys only group rows; never identity. */
export type CrossStoreLineageView = ReadonlyMap<string, LineageStoreView>

type LineageStoreRow = Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>
type LineageResolutionRow = LineageStoreRow & Pick<Worktree, 'instanceId'>

/** Paired-runtime rows live in that runtime's store; local, SSH and WSL rows live in ours.
 * Undefined when the row names no owner (legacy rows): unknown is never evidence of our store. */
export function lineageStoreKeyOfRow(row: LineageStoreRow): string | undefined {
  if (row.runtimeOwnerEnvironmentId) {
    return row.runtimeOwnerEnvironmentId
  }
  const host = parseExecutionHostId(row.hostId)
  if (!host) {
    return undefined
  }
  return host.kind === 'runtime' ? host.environmentId : OWN_LINEAGE_STORE_KEY
}

/** Paired stores are identified by the installationId each server last reported. An offline server keeps
 * its last-known identity; a removed, retired or refusing one is left out, so it neither nests nor parents. */
export function buildCrossStoreLineageView(args: {
  own: LineageStoreView
  statusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  removedEnvironmentIds: ReadonlySet<string>
  crossStoreLineageByEnvironmentId: ReadonlyMap<string, Readonly<Record<string, unknown>>>
}): CrossStoreLineageView {
  const view = new Map<string, LineageStoreView>([[OWN_LINEAGE_STORE_KEY, args.own]])
  for (const [environmentId, entry] of args.statusByEnvironmentId) {
    if (args.removedEnvironmentIds.has(environmentId) || isRuntimeHostContactRevoked(entry)) {
      continue
    }
    view.set(environmentId, {
      installationId: lastVerifiedRuntimeStatus(entry)?.hostDescriptor?.installationId,
      crossStoreLineageByChildKey: args.crossStoreLineageByEnvironmentId.get(environmentId)
    })
  }
  return view
}

/** A view from the record each child row carries (worktree.ps and feed rows) and each store's
 * verified identity; every listed store counts, so one holding only parents is still found. */
export function buildCrossStoreLineageViewOfRows<Row extends LineageStoreRow>(
  rows: Iterable<Row>,
  recordOf: (row: Row) => unknown,
  installationIdByStoreKey: ReadonlyMap<string, string | undefined>
): CrossStoreLineageView {
  const recordsByStoreKey = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const record = recordOf(row)
    const storeKey = lineageStoreKeyOfRow(row)
    if (storeKey === undefined || !isCrossStoreWorkspaceLineage(record)) {
      continue
    }
    const records = recordsByStoreKey.get(storeKey) ?? {}
    records[record.childWorkspaceKey] = record
    recordsByStoreKey.set(storeKey, records)
  }
  return new Map(
    [...installationIdByStoreKey].map(([storeKey, installationId]) => [
      storeKey,
      { installationId, crossStoreLineageByChildKey: recordsByStoreKey.get(storeKey) }
    ])
  )
}

function pushTo<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const values = map.get(key)
  if (values) {
    values.push(value)
  } else {
    map.set(key, [value])
  }
}

function soleRow<Row>(rows: readonly Row[] | undefined): Row | undefined {
  return rows?.length === 1 ? rows[0] : undefined
}

/** Child identity → parent row for every cross-store record that resolves to exactly one visible parent. */
export function resolveCrossStoreLineageParents<Row extends LineageResolutionRow>(
  rowsByIdentity: ReadonlyMap<string, Row>,
  view: CrossStoreLineageView
): Map<string, Row> {
  const parents = new Map<string, Row>()
  let hasCrossStoreRecords = false
  for (const store of view.values()) {
    if (
      store.installationId &&
      store.crossStoreLineageByChildKey &&
      Object.keys(store.crossStoreLineageByChildKey).length > 0
    ) {
      hasCrossStoreRecords = true
      break
    }
  }
  if (!hasCrossStoreRecords) {
    return parents
  }
  const storeKeysByInstallationId = new Map<string, string[]>()
  for (const [storeKey, store] of view) {
    if (store.installationId) {
      pushTo(storeKeysByInstallationId, store.installationId, storeKey)
    }
  }
  const candidates: {
    childStoreKey: string
    childWorkspaceKey: WorkspaceKey
    childInstanceId: string
    parentStoreKey: string
    parentInstanceId: string
  }[] = []
  const wantedChildInstanceIds = new Set<string>()
  const wantedParentInstanceIds = new Set<string>()
  for (const [childStoreKey, store] of view) {
    // A store without a known identity cannot tell its own copies from a parent store.
    if (!store.installationId || !store.crossStoreLineageByChildKey) {
      continue
    }
    for (const lineage of Object.values(
      validCrossStoreLineage(store.crossStoreLineageByChildKey)
    )) {
      // Two stores reporting one installationId are a copied profile; neither is the parent's.
      const parentStoreKey = soleRow(storeKeysByInstallationId.get(lineage.parent.installationId))
      if (parentStoreKey === undefined) {
        continue
      }
      candidates.push({
        childStoreKey,
        childWorkspaceKey: lineage.childWorkspaceKey,
        childInstanceId: lineage.childInstanceId,
        parentStoreKey,
        parentInstanceId: lineage.parent.instanceId
      })
      wantedChildInstanceIds.add(lineage.childInstanceId)
      wantedParentInstanceIds.add(lineage.parent.instanceId)
    }
  }
  if (candidates.length === 0) {
    return parents
  }
  const childRowsByStoreAndKey = new Map<string, Map<WorkspaceKey, [string, Row][]>>()
  const rowsByStoreAndInstance = new Map<string, Map<string, Row[]>>()
  for (const [identity, row] of rowsByIdentity) {
    const instanceId = lineageInstanceIdOfRow(row)
    if (!instanceId) {
      continue
    }
    const wantChild = wantedChildInstanceIds.has(instanceId)
    const wantParent = wantedParentInstanceIds.has(instanceId)
    if (!wantChild && !wantParent) {
      continue
    }
    const storeKey = lineageStoreKeyOfRow(row)
    if (storeKey === undefined) {
      continue
    }
    if (wantChild) {
      let byKey = childRowsByStoreAndKey.get(storeKey)
      if (!byKey) {
        byKey = new Map()
        childRowsByStoreAndKey.set(storeKey, byKey)
      }
      pushTo(byKey, workspaceKeyOfRow(row), [identity, row])
    }
    if (wantParent) {
      let byInstance = rowsByStoreAndInstance.get(storeKey)
      if (!byInstance) {
        byInstance = new Map()
        rowsByStoreAndInstance.set(storeKey, byInstance)
      }
      pushTo(byInstance, instanceId, row)
    }
  }

  for (const candidate of candidates) {
    const child = soleRow(
      childRowsByStoreAndKey
        .get(candidate.childStoreKey)
        ?.get(candidate.childWorkspaceKey)
        ?.filter(([, row]) => lineageInstanceIdOfRow(row) === candidate.childInstanceId)
    )
    if (!child) {
      continue
    }
    const parent = soleRow(
      rowsByStoreAndInstance.get(candidate.parentStoreKey)?.get(candidate.parentInstanceId)
    )
    if (parent && parent !== child[1]) {
      parents.set(child[0], parent)
    }
  }
  return parents
}
