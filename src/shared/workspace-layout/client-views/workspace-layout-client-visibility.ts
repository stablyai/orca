import type { TabGroupLayoutNode } from '../../tab-types'
import type { LayoutTab, WorkspaceLayout } from '../workspace-layout-model'

export type LayoutClientVisibility = (tab: Pick<LayoutTab, 'kind'>) => boolean

export const withoutGitGraph: LayoutClientVisibility = (tab) => tab.kind !== 'git-graph'

export function visibleLayoutGroups(workspace: WorkspaceLayout, visible: LayoutClientVisibility) {
  const ids = new Set(workspace.tabs.filter(visible).map((tab) => tab.id))
  return workspace.groups.filter(
    (group) => !group.tabOrder.length || group.tabOrder.some((id) => ids.has(id))
  )
}

/** A visible gap is before its next visible neighbor, or at the canonical end. */
export function canonicalTabGap(
  order: readonly string[],
  tabs: readonly LayoutTab[],
  index: number,
  visible?: LayoutClientVisibility,
  replacingTabId?: string
): number {
  if (!visible) {
    return Math.max(0, Math.min(index, order.length))
  }
  const ids = new Set(tabs.filter(visible).map((tab) => tab.id))
  const shown = order.filter((id) => id !== replacingTabId && ids.has(id))
  const next = shown[Math.max(0, Math.min(index, shown.length))]
  return next === undefined ? order.length : order.indexOf(next)
}

export function visibleGroupTree(
  node: TabGroupLayoutNode | undefined,
  groups: ReadonlySet<string>,
  paths?: Map<string, string>,
  fullPath = '',
  path = ''
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return groups.has(node.groupId) ? node : undefined
  }
  const join = (base: string, side: string) => (base ? `${base}.${side}` : side)
  const has = (child: TabGroupLayoutNode): boolean =>
    child.type === 'leaf' ? groups.has(child.groupId) : has(child.first) || has(child.second)
  const firstVisible = has(node.first)
  const secondVisible = has(node.second)
  if (!firstVisible) {
    return visibleGroupTree(node.second, groups, paths, join(fullPath, 'second'), path)
  }
  if (!secondVisible) {
    return visibleGroupTree(node.first, groups, paths, join(fullPath, 'first'), path)
  }
  paths?.set(path, fullPath)
  return {
    ...node,
    first: visibleGroupTree(
      node.first,
      groups,
      paths,
      join(fullPath, 'first'),
      join(path, 'first')
    )!,
    second: visibleGroupTree(
      node.second,
      groups,
      paths,
      join(fullPath, 'second'),
      join(path, 'second')
    )!
  }
}
