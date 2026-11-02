// Reparse unsettled blocks; cross-block definitions or HTML require the whole document.

import type { Nodes, Root } from 'mdast'
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
  /** Pristine tree in block-local coordinates, before rendering transforms. */
  tree?: Root
  closedFence?: boolean
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
  math = false,
  parseTree?: (source: string) => Root,
  canReuse: (tail: string) => boolean = () => !source.includes('\uFEFF')
): MarkdownBlockSplit {
  let parse = parseTree
  const grewFromPrevious = previous !== null && source.startsWith(previous.source)
  if (grewFromPrevious && previous.whole && !math) {
    return wholeDocument(source)
  }
  // A sliced, indented opener must retain the original discovery context.
  const last = grewFromPrevious ? previous.blocks.at(-1) : undefined
  let unsettled =
    parse &&
    grewFromPrevious &&
    previous.blocks.at(-UNSETTLED_BLOCKS)?.closedFence &&
    last &&
    source[last.start - 1] === '\n'
      ? 1
      : UNSETTLED_BLOCKS
  // Declining must restore the original discovery window before choosing any cuts.
  const candidateBase = grewFromPrevious ? (previous.blocks.at(-unsettled)?.start ?? 0) : 0
  if (parse && !canReuse(source.slice(candidateBase))) {
    parse = undefined
    unsettled = UNSETTLED_BLOCKS
  }
  const settled = grewFromPrevious ? previous.blocks.slice(0, -unsettled) : []
  const reparsed = grewFromPrevious ? previous.blocks.at(-unsettled) : undefined
  const base = reparsed?.start ?? 0
  const baseLine = reparsed?.line ?? 1
  const tail = source.slice(base)
  const tree = parse ? parse(tail) : (math ? mathBlockParser : blockParser).parse(tail)
  if (math) {
    chatMathCodeFences(tree, tail)
  }
  if (reachesAcrossBlocks(tree)) {
    const whole = wholeDocument(source, math && hasLiteralMath(tree))
    return parse && base === 0 ? { ...whole, blocks: [{ ...whole.blocks[0], tree }] } : whole
  }
  // Each block runs to the next one's start, so the blank lines between stay in the source.
  const points = tree.children.map((child) =>
    'position' in child ? child.position?.start : undefined
  )
  const starts = points.map((point) => point?.offset ?? 0)
  starts[0] = 0
  const blocks = starts.map((start, index): MarkdownBlock => {
    const child = tree.children[index]
    const text = tail.slice(start, starts[index + 1])
    const line = index === 0 ? 1 : (points[index]?.line ?? 1)
    const block: MarkdownBlock = {
      start: base + start,
      line: baseLine + line - 1,
      text,
      ...(math
        ? {
            literalMath: hasLiteralMath(child),
            end: base + (child?.position?.end.offset ?? tail.length)
          }
        : {})
    }
    const prior = grewFromPrevious ? previous.blocks[settled.length + index] : undefined
    if (
      prior?.tree &&
      prior.start === block.start &&
      prior.text === text &&
      prior.literalMath === block.literalMath &&
      prior.end === block.end
    ) {
      return prior
    }
    if (parse && child) {
      block.closedFence = isClosedFence(child, text, start)
      // Slicing an indented opener changes its standalone parse, so preserve that parse.
      if (index === 0 || points[index]?.column === 1) {
        block.tree = { type: 'root', children: [child] }
        shiftMarkdownPositions(block.tree, start, line - 1)
      }
    }
    return block
  })
  return { source, blocks: [...settled, ...blocks], whole: false }
}

function shiftMarkdownPositions(node: Nodes, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) {
        point.offset -= offset
      }
      point.line -= lines
    }
  }
  if ('children' in node) {
    node.children.forEach((child) => shiftMarkdownPositions(child, offset, lines))
  }
}

function isClosedFence(node: Nodes, source: string, offset: number): boolean {
  if (node.type !== 'code') {
    return false
  }
  const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(source)?.[1]
  if (!opening || !node.position) {
    return false
  }
  const end = (node.position.end.offset ?? offset + source.length) - offset
  const authored = source.slice(0, end)
  const lastLine = authored.slice(authored.lastIndexOf('\n') + 1).replace(/\r$/, '')
  return new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \t]*$`).test(lastLine)
}
