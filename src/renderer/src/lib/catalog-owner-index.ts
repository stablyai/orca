import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'

type CatalogOwnerRecord = {
  id: string
  projectGroupId?: string | null
  connectionId?: string | null
  executionHostId?: string | null
  runtimeSourceExecutionHostId?: string | null
}

type CatalogOwnerResolution<T> = { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }

function catalogOwnerHostId(owner: CatalogOwnerRecord): ExecutionHostId | null {
  return resolveFolderWorkspaceExecutionHostId({
    folderWorkspace: owner,
    fallbackHostId: 'local'
  })
}

function catalogOwnerIdentity(owner: CatalogOwnerRecord): string {
  return JSON.stringify([
    catalogOwnerHostId(owner),
    parseExecutionHostId(owner.runtimeSourceExecutionHostId)?.id ?? null,
    owner.connectionId?.trim() || null,
    owner.projectGroupId?.trim() || null
  ])
}

function catalogOwnerHostIds(owner: CatalogOwnerRecord): ExecutionHostId[] {
  const transportHostId = catalogOwnerHostId(owner)
  if (!transportHostId) {
    return []
  }
  const sourceValue = owner.runtimeSourceExecutionHostId
  const sourceHostId = parseExecutionHostId(sourceValue)?.id
  if (sourceValue !== undefined && !sourceHostId) {
    return []
  }
  return sourceHostId && sourceHostId !== transportHostId
    ? [transportHostId, sourceHostId]
    : [transportHostId]
}

function addCatalogOwnerIndexEntry<T extends CatalogOwnerRecord>(
  index: Map<string, CatalogOwnerResolution<T>>,
  key: string,
  owner: T
): void {
  const current = index.get(key)
  if (!current) {
    index.set(key, { kind: 'resolved', owner })
  } else if (
    current.kind === 'resolved' &&
    catalogOwnerIdentity(current.owner) !== catalogOwnerIdentity(owner)
  ) {
    index.set(key, { kind: 'ambiguous' })
  }
}

export function buildCatalogOwnerIndex<T extends CatalogOwnerRecord>(
  records: readonly T[]
): ReadonlyMap<string, CatalogOwnerResolution<T>> {
  const next = new Map<string, CatalogOwnerResolution<T>>()
  for (const record of records) {
    const hostIds = catalogOwnerHostIds(record)
    if (hostIds.length === 0) {
      continue
    }
    const id = record.id
    addCatalogOwnerIndexEntry(next, id, record)
    for (const hostId of hostIds) {
      addCatalogOwnerIndexEntry(next, `${id}\0${hostId}`, record)
    }
  }
  return next
}
