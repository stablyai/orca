// Reparse the last two blocks on append; cross-block definitions or HTML fall back to the whole document.

import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type MarkdownBlock = {
  /** Source offset, retained for settled blocks on append. */
  start: number
  /** One-based source line. */
  line: number
  text: string
}

export type MarkdownBlockSplit = {
  source: string
  blocks: readonly MarkdownBlock[]
  /** Cross-block content requires whole-document rendering. */
  whole: boolean
}

/** The last block, which is still growing, and the one it may yet join. */
const UNSETTLED_BLOCKS = 2

const blockParser = unified().use(remarkParse).use(remarkGfm)

/** Tags that cannot hold anything, so cannot hold a later block. */
const VOID_TAG_PATTERN = /^<(?:br|hr|wbr|img)\b[^>]*>$/i

/** References and non-void HTML can affect other blocks and require whole-document parsing. */
function reachesAcrossBlocks(node: Nodes): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') {
    return true
  }
  if (node.type === 'html') {
    return !VOID_TAG_PATTERN.test(node.value.trim())
  }
  return 'children' in node && node.children.some(reachesAcrossBlocks)
}

function wholeDocument(source: string): MarkdownBlockSplit {
  return { source, blocks: [{ start: 0, line: 1, text: source }], whole: true }
}

export function splitMarkdownTopLevelBlocks(
  source: string,
  previous: MarkdownBlockSplit | null
): MarkdownBlockSplit {
  const grewFromPrevious = previous !== null && source.startsWith(previous.source)
  if (grewFromPrevious && previous.whole) {
    return wholeDocument(source)
  }
  const settled = grewFromPrevious ? previous.blocks.slice(0, -UNSETTLED_BLOCKS) : []
  const reparsed = grewFromPrevious ? previous.blocks.at(-UNSETTLED_BLOCKS) : undefined
  const base = reparsed?.start ?? 0
  const baseLine = reparsed?.line ?? 1
  const tail = source.slice(base)
  const tree = blockParser.parse(tail)
  if (reachesAcrossBlocks(tree)) {
    return wholeDocument(source)
  }
  // Each block runs to the next one's start, so the blank lines between stay in the source.
  const points = tree.children.map((child) =>
    'position' in child ? child.position?.start : undefined
  )
  const starts = points.map((point) => point?.offset ?? 0)
  starts[0] = 0
  const blocks = starts.map((start, index) => ({
    start: base + start,
    line: baseLine + (index === 0 ? 0 : (points[index]?.line ?? 1) - 1),
    text: tail.slice(start, starts[index + 1])
  }))
  return { source, blocks: [...settled, ...blocks], whole: false }
}
