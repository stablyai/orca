import type { TabGroupLayoutNode } from '../tab-types'

export function collectLayoutGroupIds(layout: TabGroupLayoutNode | undefined): Set<string> {
  const result = new Set<string>()
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      result.add(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)
  return result
}

export function dropTabGroupLayoutGroups(
  layout: TabGroupLayoutNode | null,
  excludedGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return excludedGroupIds.has(layout.groupId) ? null : layout
  }
  const first = dropTabGroupLayoutGroups(layout.first, excludedGroupIds)
  const second = dropTabGroupLayoutGroups(layout.second, excludedGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

export function appendTabGroupLayout(
  first: TabGroupLayoutNode | null,
  second: TabGroupLayoutNode | null
): TabGroupLayoutNode | null {
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  // Never append another leaf for an already placed group; each duplicate renders another tab-strip column.
  const appended = dropTabGroupLayoutGroups(second, collectLayoutGroupIds(first))
  if (!appended) {
    return first
  }
  return {
    type: 'split',
    direction: 'horizontal',
    first,
    second: appended
  }
}
