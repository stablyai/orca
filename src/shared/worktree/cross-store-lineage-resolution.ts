import { parseExecutionHostId } from '../execution-host'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../remote-runtime/host-status/runtime-host-status'
import { worktreeWorkspaceKey, type WorkspaceKey } from '../workspace-scope'
import { isCrossStoreWorkspaceLineage, validCrossStoreLineage } from './cross-store-lineage-records'
import type { Worktree } from './types'

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

function workspaceKeyOfRow(row: Pick<Worktree, 'id'>): WorkspaceKey {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: folder rows carry their folder WorkspaceKey as id (folderWorkspaceToWorktree).
  return row.id.startsWith('folder:') ? (row.id as WorkspaceKey) : worktreeWorkspaceKey(row.id)
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
  const childRowsByStoreAndKey = new Map<string, Map<WorkspaceKey, [string, Row][]>>()
  const rowsByStoreAndInstance = new Map<string, Map<string, Row[]>>()
  for (const [identity, row] of rowsByIdentity) {
    if (!row.instanceId) {
      continue
    }
    const storeKey = lineageStoreKeyOfRow(row)
    if (storeKey === undefined) {
      continue
    }
    let byKey = childRowsByStoreAndKey.get(storeKey)
    let byInstance = rowsByStoreAndInstance.get(storeKey)
    if (!byKey || !byInstance) {
      byKey = new Map()
      byInstance = new Map()
      childRowsByStoreAndKey.set(storeKey, byKey)
      rowsByStoreAndInstance.set(storeKey, byInstance)
    }
    pushTo(byKey, workspaceKeyOfRow(row), [identity, row])
    pushTo(byInstance, row.instanceId, row)
  }
  const storeKeysByInstallationId = new Map<string, string[]>()
  for (const [storeKey, store] of view) {
    if (store.installationId) {
      pushTo(storeKeysByInstallationId, store.installationId, storeKey)
    }
  }

  const parents = new Map<string, Row>()
  for (const [childStoreKey, store] of view) {
    // A store without a known identity cannot tell its own copies from a parent store.
    if (!store.installationId) {
      continue
    }
    for (const lineage of Object.values(
      validCrossStoreLineage(store.crossStoreLineageByChildKey)
    )) {
      const child = soleRow(
        childRowsByStoreAndKey
          .get(childStoreKey)
          ?.get(lineage.childWorkspaceKey)
          ?.filter(([, row]) => row.instanceId === lineage.childInstanceId)
      )
      // Two stores reporting one installationId are a copied profile; neither is the parent's.
      const parentStoreKey = soleRow(storeKeysByInstallationId.get(lineage.parent.installationId))
      if (!child || parentStoreKey === undefined) {
        continue
      }
      const parent = soleRow(
        rowsByStoreAndInstance.get(parentStoreKey)?.get(lineage.parent.instanceId)
      )
      if (parent && parent !== child[1]) {
        parents.set(child[0], parent)
      }
    }
  }
  return parents
}
