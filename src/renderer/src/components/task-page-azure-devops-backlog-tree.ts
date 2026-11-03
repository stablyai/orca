import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'

export type BacklogItemRow = {
  key: string
  kind: 'parent' | 'item' | 'child'
  item: AzureDevOpsWorkItem
  depth: number
  hasChildren: boolean
  expanded: boolean
}
export type BacklogGroupRow = { key: 'unparented'; kind: 'group'; label: string; depth: 0 }
export type BacklogRow = BacklogItemRow | BacklogGroupRow

export type BuildBacklogRowsOptions = {
  showParents: boolean
  /**
   * Ids whose expansion the user flipped from the default. Parent groups start
   * expanded (ADO behaviour) and level items start collapsed, so one set covers both.
   */
  toggled: ReadonlySet<number>
  unparentedLabel: string
}

export function buildBacklogRows(
  page: AzureDevOpsBacklogPage,
  options: BuildBacklogRowsOptions
): BacklogRow[] {
  const childById = new Map(page.children.map((c) => [c.id, c]))
  const rows: BacklogRow[] = []

  const pushItem = (item: AzureDevOpsWorkItem, depth: number): void => {
    const childIds = page.childrenByParent[item.id] ?? []
    const expanded = options.toggled.has(item.id)
    rows.push({
      key: `item:${item.id}`,
      kind: 'item',
      item,
      depth,
      hasChildren: childIds.length > 0,
      expanded
    })
    if (!expanded) {
      return
    }
    for (const childId of childIds) {
      const child = childById.get(childId)
      if (child) {
        rows.push({
          key: `child:${child.id}`,
          kind: 'child',
          item: child,
          depth: depth + 1,
          hasChildren: false,
          expanded: false
        })
      }
    }
  }

  if (!options.showParents) {
    for (const item of page.items) {
      pushItem(item, 0)
    }
    return rows
  }

  const itemsByParent = new Map<number | null, AzureDevOpsWorkItem[]>()
  for (const item of page.items) {
    const key =
      item.parentId !== null && page.parents.some((p) => p.id === item.parentId)
        ? item.parentId
        : null
    const bucket = itemsByParent.get(key) ?? []
    itemsByParent.set(key, bucket)
    bucket.push(item)
  }
  // Why: ADO orders parent groups by the parent's own stack rank, not by first child.
  const parents = [...page.parents].sort(
    (a, b) => (a.stackRank ?? Number.MAX_SAFE_INTEGER) - (b.stackRank ?? Number.MAX_SAFE_INTEGER)
  )
  for (const parent of parents) {
    const expanded = !options.toggled.has(parent.id)
    const children = itemsByParent.get(parent.id) ?? []
    rows.push({
      key: `parent:${parent.id}`,
      kind: 'parent',
      item: parent,
      depth: 0,
      hasChildren: children.length > 0,
      expanded
    })
    if (expanded) {
      for (const item of children) {
        pushItem(item, 1)
      }
    }
  }
  const unparented = itemsByParent.get(null) ?? []
  if (unparented.length > 0) {
    rows.push({ key: 'unparented', kind: 'group', label: options.unparentedLabel, depth: 0 })
    for (const item of unparented) {
      pushItem(item, 1)
    }
  }
  return rows
}
