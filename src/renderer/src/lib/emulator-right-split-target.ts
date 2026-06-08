import type { TabGroupLayoutNode } from '../../../shared/types'

type SearchResult = {
  containsSource: boolean
  reusableGroupId: string | null
}

function firstLeafGroupId(node: TabGroupLayoutNode): string {
  if (node.type === 'leaf') {
    return node.groupId
  }
  return firstLeafGroupId(node.first)
}

function findReusableRightSplitTarget(
  node: TabGroupLayoutNode,
  sourceGroupId: string
): SearchResult {
  if (node.type === 'leaf') {
    return {
      containsSource: node.groupId === sourceGroupId,
      reusableGroupId: null
    }
  }

  const first = findReusableRightSplitTarget(node.first, sourceGroupId)
  if (first.containsSource) {
    return {
      containsSource: true,
      // Why: prefer the closest existing right pane; it preserves nested split intent.
      reusableGroupId:
        first.reusableGroupId ??
        (node.direction === 'horizontal' ? firstLeafGroupId(node.second) : null)
    }
  }

  const second = findReusableRightSplitTarget(node.second, sourceGroupId)
  return {
    containsSource: second.containsSource,
    reusableGroupId: second.reusableGroupId
  }
}

export function findReusableRightSplitGroupId(
  layout: TabGroupLayoutNode | undefined,
  sourceGroupId: string
): string | null {
  if (!layout) {
    return null
  }
  return findReusableRightSplitTarget(layout, sourceGroupId).reusableGroupId
}
