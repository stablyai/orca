import { parseWorkspaceKey } from '../workspace-scope'
import { lineageStoreKeyOfRow, OWN_LINEAGE_STORE_KEY } from './cross-store-lineage-resolution'
import type { WorkspaceLineageEdge } from './lineage-types'
import type { Worktree } from './types'

/** What folder resolution reads off a row; folder rows carry their `folder:<id>` key as id. */
export type FolderLineageRow = Pick<
  Worktree,
  'id' | 'hostId' | 'runtimeOwnerEnvironmentId' | 'instanceId' | 'isArchived'
>

/** A row's saved workspace record (list 2), as the reader holds it; undefined when it has none. */
export type FolderLineageRecordOf<Row extends FolderLineageRow = Worktree> = (
  row: Row
) => WorkspaceLineageEdge | null | undefined

/** What a host reports for a row: its folder workspace parent, unless the record names an earlier
 * workspace at the same path. Other workspace records repeat the worktree lineage and stay off. */
export function folderLineageEdgeOf(
  record: WorkspaceLineageEdge | null | undefined,
  instanceId: string | undefined
): WorkspaceLineageEdge | null {
  if (
    !record?.parentWorkspaceKey.startsWith('folder:') ||
    (record.childInstanceId && record.childInstanceId !== instanceId)
  ) {
    return null
  }
  return {
    parentWorkspaceKey: record.parentWorkspaceKey,
    parentInstanceId: record.parentInstanceId ?? null,
    childInstanceId: record.childInstanceId ?? null
  }
}

// Rows listed without a host id are the lister's own.
function storeOf(row: FolderLineageRow): string | undefined {
  return row.hostId || row.runtimeOwnerEnvironmentId
    ? lineageStoreKeyOfRow(row)
    : OWN_LINEAGE_STORE_KEY
}

/** Child identity → folder workspace row, for workspace records whose parent is a folder in the
 * child's own store. A record whose child instance differs belongs to an earlier workspace at the
 * same path; a legacy record without a parent instance names the folder by key alone. Folders are
 * exempt from the host boundary, as when the link was saved (a local folder parents an SSH child). */
export function resolveFolderLineageParents<Row extends FolderLineageRow>(
  rowsByHostIdentity: ReadonlyMap<string, Row>,
  recordOf: FolderLineageRecordOf<Row>
): Map<string, Row> {
  const folderByStoreKey = new Map<string, Row | null>()
  for (const row of rowsByHostIdentity.values()) {
    const scope = parseWorkspaceKey(row.id)
    const store = storeOf(row)
    if (scope?.type !== 'folder' || store === undefined) {
      continue
    }
    const key = `${store}\0${scope.folderWorkspaceId}`
    // Two rows claiming one folder id in a store cannot be told apart: neither parents.
    folderByStoreKey.set(key, folderByStoreKey.has(key) ? null : row)
  }
  const parents = new Map<string, Row>()
  if (folderByStoreKey.size === 0) {
    return parents
  }
  for (const [identity, row] of rowsByHostIdentity) {
    const record = recordOf(row)
    const parentScope = record ? parseWorkspaceKey(record.parentWorkspaceKey) : null
    const store = storeOf(row)
    if (
      !record ||
      parentScope?.type !== 'folder' ||
      store === undefined ||
      (record.childInstanceId && record.childInstanceId !== row.instanceId) ||
      (record.parentInstanceId && record.parentInstanceId !== parentScope.folderWorkspaceId)
    ) {
      continue
    }
    const folder = folderByStoreKey.get(`${store}\0${parentScope.folderWorkspaceId}`)
    if (folder && !folder.isArchived) {
      parents.set(identity, folder)
    }
  }
  return parents
}
