import type { Slice } from '@tiptap/pm/model'
import {
  getRichMarkdownLeafVisibleText,
  isRichMarkdownVisibleBlockStart
} from './rich-markdown-visible-text-map'

export const RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT = 256 * 1024
export const RICH_MARKDOWN_SOURCE_OWNING_NODE_LIMIT = 256

export type RichMarkdownSourceOwningSliceStatus = {
  containsSourceOwningNode: boolean
  canPreserve: boolean
}

export function inspectRichMarkdownSourceOwningSlice(
  slice: Slice
): RichMarkdownSourceOwningSliceStatus {
  let sourceBytes = 0
  let visibleBytes = 0
  let nodeCount = 0
  let containsSourceOwningNode = false
  let canPreserve = true
  let sawVisibleBlock = false

  slice.content.descendants((node, pos, parent, index) => {
    const startsVisibleBlock = isRichMarkdownVisibleBlockStart(node)
    if (canPreserve && startsVisibleBlock) {
      if (sawVisibleBlock) {
        const separator = addUtf8BytesWithinLimit(
          visibleBytes,
          '\n',
          RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT
        )
        visibleBytes = separator.byteLength
        canPreserve = !separator.exceeded
      }
      sawVisibleBlock = true
    }
    if (node.type.name === 'richMarkdownHtmlSuperscriptLink') {
      containsSourceOwningNode = true
      if (!canPreserve) {
        return false
      }
      nodeCount += 1
      const sourceMeasurement = addUtf8BytesWithinLimit(
        sourceBytes,
        String(node.attrs.source ?? ''),
        RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT
      )
      sourceBytes = sourceMeasurement.byteLength
      canPreserve =
        !sourceMeasurement.exceeded && nodeCount <= RICH_MARKDOWN_SOURCE_OWNING_NODE_LIMIT
      if (!canPreserve) {
        return false
      }
    }
    if (!canPreserve) {
      // Keep walking only far enough to detect a later source-owning atom.
      return true
    }
    const visible = node.isText
      ? (node.text ?? '')
      : node.isLeaf
        ? getRichMarkdownLeafVisibleText(node, pos, parent, index)
        : ''
    if (visible) {
      const measurement = addUtf8BytesWithinLimit(
        visibleBytes,
        visible,
        RICH_MARKDOWN_SOURCE_OWNING_PASTE_LIMIT
      )
      visibleBytes = measurement.byteLength
      canPreserve = !measurement.exceeded
    }
    return true
  })

  return { containsSourceOwningNode, canPreserve }
}

function addUtf8BytesWithinLimit(
  current: number,
  value: string,
  limit: number
): { byteLength: number; exceeded: boolean } {
  const remaining = limit - current
  if (value.length > remaining) {
    return { byteLength: limit + 1, exceeded: true }
  }
  let byteLength = current
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0
    byteLength += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (byteLength > limit) {
      return { byteLength, exceeded: true }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return { byteLength, exceeded: false }
}
