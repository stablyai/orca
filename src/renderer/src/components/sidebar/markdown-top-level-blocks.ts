// Cuts markdown source into its top-level blocks so a growing document can be
// rendered block by block: text appended to the end changes only the last block,
// and every block before it keeps its rendered result.
//
// The cut reuses the previous one. Appended text can change the last block and
// join it to the one before (a loose list gaining its next item), but reaches no
// further back, so only the source from the second-to-last block is parsed again.

import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type MarkdownBlock = {
  /** Where the block starts in the source; it never moves as text is appended. */
  start: number
  text: string
}

export type MarkdownBlockSplit = {
  source: string
  /** In order; their text joined is the source. */
  blocks: readonly MarkdownBlock[]
  /** The document cannot be cut: something in it reaches across blocks. */
  whole: boolean
}

/** The last block, which is still growing, and the one it may yet join. */
const UNSETTLED_BLOCKS = 2

const blockParser = unified().use(remarkParse).use(remarkGfm)

/** Tags that cannot hold anything, so cannot hold a later block. */
const VOID_TAG_PATTERN = /^<(?:br|hr|wbr|img)\b[^>]*>$/i

/** Whether anything in the node reaches into other blocks, however deeply it is nested.
 *  A definition resolves references elsewhere. Raw HTML is re-parsed across the whole
 *  document, so a tag opened in one block may close in a later one. */
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
  return { source, blocks: [{ start: 0, text: source }], whole: true }
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
  const base = grewFromPrevious ? (previous.blocks.at(-UNSETTLED_BLOCKS)?.start ?? 0) : 0
  const tail = source.slice(base)
  const tree = blockParser.parse(tail)
  if (reachesAcrossBlocks(tree)) {
    return wholeDocument(source)
  }
  // Each block runs to the next one's start, so the blank lines between stay in the source.
  const starts = tree.children.map(
    (child) => ('position' in child ? child.position?.start.offset : undefined) ?? 0
  )
  starts[0] = 0
  const blocks = starts.map((start, index) => ({
    start: base + start,
    text: tail.slice(start, starts[index + 1])
  }))
  return { source, blocks: [...settled, ...blocks], whole: false }
}
