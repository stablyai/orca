// Reparse the last two blocks on append; cross-block definitions or HTML fall back to the whole document.

import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { remarkChatMath } from './chat-markdown-math'
import { chatMathCodeFences } from './chat-markdown-math-nodes'
import { unified } from 'unified'

export type MarkdownBlock = {
  /** Source offset, retained for settled blocks on append. */
  start: number
  /** One-based source line. */
  line: number
  text: string
  literalMath?: boolean
  /** Parser-owned end, excluding separators held for the next block. */
  end?: number
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
const mathBlockParser = blockParser().use(remarkChatMath)

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

function hasLiteralMath(node: Nodes | undefined): boolean {
  if (!node) {
    return false
  }
  return (
    node.data?.mathComplete === false ||
    node.data?.mathLiteral === true ||
    ('children' in node && node.children.some(hasLiteralMath))
  )
}

function wholeDocument(source: string, literalMath = false): MarkdownBlockSplit {
  return { source, blocks: [{ start: 0, line: 1, text: source, literalMath }], whole: true }
}

export function splitMarkdownTopLevelBlocks(
  source: string,
  previous: MarkdownBlockSplit | null,
  math = false
): MarkdownBlockSplit {
  const grewFromPrevious = previous !== null && source.startsWith(previous.source)
  if (grewFromPrevious && previous.whole && !math) {
    return wholeDocument(source)
  }
  const settled = grewFromPrevious ? previous.blocks.slice(0, -UNSETTLED_BLOCKS) : []
  const reparsed = grewFromPrevious ? previous.blocks.at(-UNSETTLED_BLOCKS) : undefined
  const base = reparsed?.start ?? 0
  const baseLine = reparsed?.line ?? 1
  const tail = source.slice(base)
  const tree = (math ? mathBlockParser : blockParser).parse(tail)
  if (math) {
    chatMathCodeFences(tree, tail)
  }
  if (reachesAcrossBlocks(tree)) {
    return wholeDocument(source, math && hasLiteralMath(tree))
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
    text: tail.slice(start, starts[index + 1]),
    ...(math
      ? {
          literalMath: hasLiteralMath(tree.children[index]),
          end: base + (tree.children[index]?.position?.end.offset ?? tail.length)
        }
      : {})
  }))
  return { source, blocks: [...settled, ...blocks], whole: false }
}
