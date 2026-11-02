import type { TestElement } from './testing-tree'

type Row = { key: string; disabled?: boolean }
type TreeItem = { key: string; disabled?: boolean; hasChildren?: boolean; children?: unknown[] }

function isKeyed(value: unknown): value is Row {
  return (
    typeof value === 'object' && value !== null && 'key' in value && typeof value.key === 'string'
  )
}

export function tableRows(table: TestElement): Row[] {
  return Array.isArray(table.props.rows) ? table.props.rows.filter(isKeyed) : []
}

/** Every item of a Tree, at any depth. */
export function treeItems(tree: TestElement): TreeItem[] {
  const out: TreeItem[] = []
  const pending: unknown[] = Array.isArray(tree.props.items) ? [...tree.props.items] : []
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (isKeyed(next)) {
      out.push(next)
      const children: unknown = 'children' in next ? next.children : undefined
      if (Array.isArray(children)) {
        pending.push(...children)
      }
    }
  }
  return out
}

export function expectType(element: TestElement, type: string, verb: string): void {
  if (element.type !== type) {
    throw new Error(`${verb}: expected a ${type}, not a ${element.type}`)
  }
}

export function enabledRow(table: TestElement, key: string, verb: string): Row {
  const row = tableRows(table).find((entry) => entry.key === key)
  if (!row || row.disabled === true) {
    throw new Error(`${verb}: the Table has no enabled row "${key}"`)
  }
  return row
}

export function treeItem(tree: TestElement, key: string, verb: string): TreeItem {
  const item = treeItems(tree).find((entry) => entry.key === key)
  if (!item) {
    throw new Error(`${verb}: the Tree has no item "${key}"`)
  }
  return item
}

export function isExpandable(item: TreeItem): boolean {
  return item.hasChildren === true || (Array.isArray(item.children) && item.children.length > 0)
}

/** The next sort a header click asks for: ascending first, then flipping. */
export function nextSort(
  table: TestElement,
  column: string
): { column: string; direction: 'asc' | 'desc' } {
  const columns = Array.isArray(table.props.columns) ? table.props.columns : []
  const found: unknown = columns.find(
    (entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'key' in entry && entry.key === column
  )
  if (!found || typeof found !== 'object' || !('sortable' in found) || found.sortable !== true) {
    throw new Error(`sort: the Table has no sortable column "${column}"`)
  }
  const sort: unknown = table.props.sort
  const ascending =
    typeof sort === 'object' &&
    sort !== null &&
    'column' in sort &&
    sort.column === column &&
    'direction' in sort &&
    sort.direction === 'asc'
  return { column, direction: ascending ? 'desc' : 'asc' }
}
