import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import { MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS } from './markdown-preview-document-types'

export const MARKDOWN_PREVIEW_OVERSCAN = 3

export function markdownPreviewMinimumRowHeight(viewportHeight: number): number {
  // Reserve overscan, a pinned composer, and partially visible edge rows.
  return Math.max(40, Math.ceil(viewportHeight / (MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS - 9)))
}

export function markdownPreviewViewportIndices(range: Range, pinnedIndex: number): number[] {
  const indices = new Set<number>()
  if (pinnedIndex >= 0) {
    indices.add(pinnedIndex)
  }
  for (let index = range.startIndex; index <= range.endIndex; index += 1) {
    indices.add(index)
  }
  for (const index of defaultRangeExtractor(range)) {
    if (indices.size >= MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS) {
      break
    }
    indices.add(index)
  }
  return [...indices].slice(0, MARKDOWN_PREVIEW_MAX_REQUESTED_BLOCKS).sort((a, b) => a - b)
}

export function markdownPreviewRequestIndices(
  indices: number[],
  priorityIndices: number[]
): number[] {
  return [...new Set([...priorityIndices.filter((index) => indices.includes(index)), ...indices])]
}
