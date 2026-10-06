import type { Root, RootContent, Nodes } from 'hast'
import {
  countMarkdownPreviewNodes,
  getMarkdownPreviewTreeText,
  isMarkdownPreviewBlockTooLarge
} from './markdown-preview-tree-content'
export {
  countMarkdownPreviewNodes,
  getMarkdownPreviewTreeText,
  isMarkdownPreviewBlockTooLarge
} from './markdown-preview-tree-content'
import { splitMarkdownPreviewTable } from './markdown-preview-table-chunks'
import type { Root as MarkdownRoot, Nodes as MarkdownNodes } from 'mdast'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import { unified } from 'unified'
import {
  MARKDOWN_REMARK_PLUGINS,
  MARKDOWN_REHYPE_NORMALIZATION_PLUGINS,
  MARKDOWN_REHYPE_EXPANSION_PLUGINS
} from './markdown-preview-plugins'
import {
  MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES,
  MARKDOWN_PREVIEW_BLOCK_MAX_NODES,
  type MarkdownPreviewDocument,
  type MarkdownPreviewRenderedBlock
} from './markdown-preview-document-types'
import type { MarkdownTocItem, MarkdownTocLevel } from './markdown-table-of-contents'

function assertDocumentBudget(tree: MarkdownRoot | Root): void {
  if (
    countMarkdownPreviewNodes(tree, MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES) >
    MARKDOWN_PREVIEW_DOCUMENT_MAX_NODES
  ) {
    throw new Error('Document exceeds the preview complexity limit.')
  }
}

function collectAnchors(node: RootContent, anchors: string[], headings: MarkdownTocItem[]): void {
  if (node.type !== 'element') {
    return
  }
  const id = node.properties.id
  if (typeof id === 'string') {
    anchors.push(id)
    if (/^h[1-5]$/.test(node.tagName)) {
      const level = Number(node.tagName.slice(1))
      if (isTocLevel(level)) {
        headings.push({ id, level, title: getMarkdownPreviewTreeText(node), children: [] })
      }
    }
  }
  for (const child of node.children) {
    collectAnchors(child, anchors, headings)
  }
}

function isTocLevel(level: number): level is MarkdownTocLevel {
  return level >= 1 && level <= 5
}

function nestHeadings(headings: MarkdownTocItem[]): MarkdownTocItem[] {
  const roots: MarkdownTocItem[] = []
  const stack: MarkdownTocItem[] = []
  for (const heading of headings) {
    while ((stack.at(-1)?.level ?? 0) >= heading.level) {
      stack.pop()
    }
    const parent = stack.at(-1)
    if (parent) {
      parent.children.push(heading)
    } else {
      roots.push(heading)
    }
    stack.push(heading)
  }
  return roots
}

function sourceBounds(node: Nodes): { sourceLine: number | null; sourceEndLine: number | null } {
  if (node.position) {
    return { sourceLine: node.position.start.line, sourceEndLine: node.position.end.line }
  }
  const children = 'children' in node ? node.children.map(sourceBounds) : []
  const starts = children.flatMap((child) => (child.sourceLine === null ? [] : [child.sourceLine]))
  const ends = children.flatMap((child) =>
    child.sourceEndLine === null ? [] : [child.sourceEndLine]
  )
  return {
    sourceLine: starts.length
      ? starts.reduce((minimum, line) => Math.min(minimum, line), Infinity)
      : null,
    sourceEndLine: ends.length
      ? ends.reduce((maximum, line) => Math.max(maximum, line), -Infinity)
      : null
  }
}

export function parseMarkdownPreviewDocument(content: string): {
  tree: Root
  document: MarkdownPreviewDocument
} {
  const parser = unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS)
  const parsed = parser.parse(content)
  assertDocumentBudget(parsed)
  // Raw HTML may span Markdown blocks, so normalize it before dividing the document.
  const containsHtml = hasHtml(parsed)
  const processor = parser()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(containsHtml ? [rehypeRaw] : [])
    .use(MARKDOWN_REHYPE_NORMALIZATION_PLUGINS)
  const tree = processor.runSync(parsed)
  assertDocumentBudget(tree)
  tree.children = tree.children.filter(
    (node) => node.type !== 'text' || node.value.trim().length > 0
  )
  tree.children = tree.children.flatMap(splitMarkdownPreviewTable)
  assertDocumentBudget(tree)
  const headings: MarkdownTocItem[] = []
  const blocks = tree.children.map((node, index) => {
    const anchors: string[] = []
    collectAnchors(node, anchors, headings)
    const textLength = getMarkdownPreviewTreeText(node).length
    return {
      index,
      anchors,
      sourceColumn: node.position?.start.column,
      estimate: Math.min(1200, Math.max(40, Math.ceil(textLength / 90) * 24 + 32)),
      ...sourceBounds(node)
    }
  })
  return { tree, document: { blocks, toc: nestHeadings(headings) } }
}

function hasHtml(node: MarkdownNodes): boolean {
  if (node.type === 'html') {
    return true
  }
  return 'children' in node && node.children.some((child) => hasHtml(child))
}

const expansion = unified().use(MARKDOWN_REHYPE_EXPANSION_PLUGINS)

export function markdownPreviewBlockHasMath(node: Nodes): boolean {
  if (
    node.type === 'element' &&
    node.properties.className
      ?.toString()
      .match(/(?:^|[, ])(?:language-math|math-inline|math-display)(?:$|[, ])/)
  ) {
    return true
  }
  return 'children' in node && node.children.some(markdownPreviewBlockHasMath)
}

export function renderMarkdownPreviewBlock(
  node: RootContent,
  index: number
): MarkdownPreviewRenderedBlock {
  const sourceTree: Root = { type: 'root', children: [node] }
  const tooLarge = isMarkdownPreviewBlockTooLarge(node)
  if (tooLarge) {
    return { index, tree: { type: 'root', children: [] }, oversized: true }
  }
  const tree = structuredClone(sourceTree)
  const expanded = expansion.runSync(tree)
  if (!isHastRoot(expanded)) {
    throw new Error('Invalid rendered preview block.')
  }
  const oversized =
    countMarkdownPreviewNodes(expanded, MARKDOWN_PREVIEW_BLOCK_MAX_NODES) >
    MARKDOWN_PREVIEW_BLOCK_MAX_NODES
  if (oversized && !markdownPreviewBlockHasMath(node)) {
    return { index, tree: structuredClone(sourceTree), oversized: false }
  }
  return { index, tree: expanded, oversized }
}

function isHastRoot(node: { type: string }): node is Root {
  return node.type === 'root' && 'children' in node && Array.isArray(node.children)
}
