/**
 * Pure helpers for explorer "Compare Selected Files" (#10033).
 */

export type FileCompareNode = {
  path: string
  relativePath: string
  isDirectory: boolean
}

export function canCompareSelectedFiles(nodes: readonly FileCompareNode[]): boolean {
  return nodes.length === 2 && nodes.every((node) => !node.isDirectory)
}

/** Canonical order so A↔B and B↔A open the same tab. */
export function orderFileComparePair(
  left: FileCompareNode,
  right: FileCompareNode
): [FileCompareNode, FileCompareNode] {
  if (left.relativePath < right.relativePath) {
    return [left, right]
  }
  if (left.relativePath > right.relativePath) {
    return [right, left]
  }
  if (left.path <= right.path) {
    return [left, right]
  }
  return [right, left]
}

export function buildFileComparePairKey(leftRelativePath: string, rightRelativePath: string): string {
  return leftRelativePath <= rightRelativePath
    ? `${leftRelativePath}::${rightRelativePath}`
    : `${rightRelativePath}::${leftRelativePath}`
}

export function formatFileCompareTabLabel(leftRelativePath: string, rightRelativePath: string): string {
  const leftName = leftRelativePath.split(/[/\\]/).pop() || leftRelativePath
  const rightName = rightRelativePath.split(/[/\\]/).pop() || rightRelativePath
  return `${leftName} ↔ ${rightName}`
}
