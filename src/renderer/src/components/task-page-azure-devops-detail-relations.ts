import type {
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail
} from '../../../shared/azure-devops/boards-types'

/**
 * The dialog's Parent and Children rows. The active view's items come first, so
 * the Board — whose items are the board's cards and their off-board parents —
 * falls back to the children the host hydrated with the detail itself.
 */
export function resolveAzureDevOpsDetailRelations(args: {
  detail: AzureDevOpsWorkItemDetail | null
  itemById: ReadonlyMap<number, AzureDevOpsWorkItem>
}): { parent: AzureDevOpsWorkItem | null; childItems: AzureDevOpsWorkItem[] } {
  const { detail, itemById } = args
  if (!detail) {
    return { parent: null, childItems: [] }
  }
  const fromDetail = new Map((detail.children ?? []).map((child) => [child.id, child]))
  return {
    parent: detail.parentId === null ? null : (itemById.get(detail.parentId) ?? null),
    childItems: detail.childIds
      .map((id) => itemById.get(id) ?? fromDetail.get(id))
      .filter((child): child is AzureDevOpsWorkItem => child !== undefined)
  }
}
