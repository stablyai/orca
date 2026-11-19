// Reparse unsettled blocks against the definitions settled ones made; HTML that can span blocks
// requires the whole document.

import type { Nodes, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { remarkChatMath } from './chat-markdown-math'
import { chatMathCodeFences } from './chat-markdown-math-nodes'
import { unified } from 'unified'
import {
  collectDefinitions,
  definitionContext,
  definitionKey,
  hasUnsharedDefinitions,
  type MarkdownDefinition
} from './markdown-block-definitions'

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
  /** Definitions the blocks make, with their absolute start, in document order. */
  definitions: readonly MarkdownDefinition[]
}

/** The last block, which is still growing, and the one it may yet join. */
const UNSETTLED_BLOCKS = 2

const blockParser = unified().use(remarkParse).use(remarkGfm)
const mathBlockParser = blockParser().use(remarkChatMath)

/** Tags that cannot hold anything, so cannot hold a later block. */
const VOID_TAG_PATTERN = /^<(?:br|hr|wbr|img)\b[^>]*>$/i

/** HTML that rendering turns into text, such as Vec<T> in prose, never reaches the HTML parser. */
export type HtmlRendersAsText = (html: string) => boolean

/** Non-void HTML can affect other blocks and requires whole-document parsing. */
function reachesAcrossBlocks(node: Nodes, rendersAsText?: HtmlRendersAsText): boolean {
  if (node.type === 'html') {
    return !VOID_TAG_PATTERN.test(node.value.trim()) && !rendersAsText?.(node.value)
  }
  return (
    'children' in node && node.children.some((child) => reachesAcrossBlocks(child, rendersAsText))
  )
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
  return {
    source,
    blocks: [{ start: 0, line: 1, text: source, literalMath }],
    whole: true,
    definitions: []
  }
}

export function splitMarkdownTopLevelBlocks(
  source: string,
  previous: MarkdownBlockSplit | null,
  math = false,
  parseTree?: (source: string) => Root,
  canReuse: (tail: string) => boolean = () => !source.includes('\uFEFF'),
  rendersAsText?: HtmlRendersAsText
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
  // Settled definitions are appended so the tail's references resolve; their nodes are dropped.
  const settledDefinitions = grewFromPrevious
    ? previous.definitions.filter((definition) => definition.start < base)
    : []
  const context = definitionContext(settledDefinitions)
  const parsed = context ? `${tail}\n\n${context}` : tail
  const tree = parse ? parse(parsed) : (math ? mathBlockParser : blockParser).parse(parsed)
  tree.children = tree.children.filter(
    (child) => (child.position?.start.offset ?? 0) < tail.length
  )
  if (math) {
    chatMathCodeFences(tree, tail)
  }
  const tailDefinitions = collectDefinitions(tree, tail, base)
  const definitions = [...settledDefinitions, ...tailDefinitions]
  if (
    reachesAcrossBlocks(tree, rendersAsText) ||
    hasUnsharedDefinitions(tree) ||
    // Without kept trees a block's references are unknown, so only the whole document numbers them.
    (!parse && definitions.length > 0)
  ) {
    const whole = wholeDocument(source, math && hasLiteralMath(tree))
    return parse && base === 0 && !context
      ? { ...whole, blocks: [{ ...whole.blocks[0], tree }] }
      : whole
  }
  // A new definition can resolve references earlier blocks already parsed as text.
  const known = new Set(
    grewFromPrevious
      ? previous.definitions.map(({ kind, identifier }) => definitionKey(kind, identifier))
      : []
  )
  if (
    settled.length > 0 &&
    tailDefinitions.some(({ kind, identifier }) => !known.has(definitionKey(kind, identifier)))
  ) {
    return splitMarkdownTopLevelBlocks(source, null, math, parseTree, canReuse, rendersAsText)
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
  return { source, blocks: [...settled, ...blocks], whole: false, definitions }
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
