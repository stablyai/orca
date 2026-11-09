import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { countRichMarkdownReviewMarkdownLines } from './rich-markdown-review-line-count'

export type RichMarkdownCommentBlock = {
  key: string
  startLine: number
  endLine: number
  from: number
  to: number
}

function richMarkdownNodeJson(node: ProseMirrorNode): JSONContent {
  return node.toJSON()
}

function serializeRichMarkdownJson(editor: Editor, content: JSONContent[]): string {
  return (editor.markdown?.serialize({ type: 'doc', content }) ?? '').trimEnd()
}

type RichMarkdownCommentBlockCounts = {
  nodes: WeakMap<ProseMirrorNode, number>
  separators: WeakMap<ProseMirrorNode, WeakMap<ProseMirrorNode, number>>
}

function createCommentBlockCounts(): RichMarkdownCommentBlockCounts {
  return { nodes: new WeakMap(), separators: new WeakMap() }
}

export function buildRichMarkdownCommentBlocks(editor: Editor): RichMarkdownCommentBlock[] {
  return buildCommentBlocksWithCounts(editor, createCommentBlockCounts())
}

function buildCommentBlocksWithCounts(
  editor: Editor,
  counts: RichMarkdownCommentBlockCounts
): RichMarkdownCommentBlock[] {
  const blocks: RichMarkdownCommentBlock[] = []
  let nextLine = 1
  let previousNode: ProseMirrorNode | null = null
  let previousNodeJson: JSONContent | undefined
  let previousNodeLineCount = 0

  editor.state.doc.forEach((node, nodeOffset, index) => {
    let nodeJson: JSONContent | undefined
    let nodeLineCount = counts.nodes.get(node)
    if (nodeLineCount === undefined) {
      nodeJson = richMarkdownNodeJson(node)
      nodeLineCount = countRichMarkdownReviewMarkdownLines(
        serializeRichMarkdownJson(editor, [nodeJson])
      )
      counts.nodes.set(node, nodeLineCount)
    }
    if (previousNode) {
      let separatorCounts = counts.separators.get(previousNode)
      if (!separatorCounts) {
        separatorCounts = new WeakMap()
        counts.separators.set(previousNode, separatorCounts)
      }
      let separatorLineCount = separatorCounts.get(node)
      if (separatorLineCount === undefined) {
        previousNodeJson ??= richMarkdownNodeJson(previousNode)
        nodeJson ??= richMarkdownNodeJson(node)
        const pairMarkdown = serializeRichMarkdownJson(editor, [previousNodeJson, nodeJson])
        separatorLineCount = Math.max(
          0,
          countRichMarkdownReviewMarkdownLines(pairMarkdown) - previousNodeLineCount - nodeLineCount
        )
        separatorCounts.set(node, separatorLineCount)
      }
      nextLine += separatorLineCount
    }
    const startLine = nextLine
    const endLine = Math.max(startLine, startLine + nodeLineCount - 1)
    const from = nodeOffset + 1
    blocks.push({
      key: `${index}:${startLine}-${endLine}`,
      startLine,
      endLine,
      from,
      to: from + Math.max(0, node.nodeSize - 1)
    })
    nextLine = endLine + 1
    previousNode = node
    previousNodeJson = nodeJson
    previousNodeLineCount = nodeLineCount
  })

  if (blocks.length === 0) {
    blocks.push({ key: 'empty:1-1', startLine: 1, endLine: 1, from: 1, to: 1 })
  }

  return blocks
}

type RichMarkdownCommentBlocksSnapshot = {
  doc: Editor['state']['doc']
  markdown: Editor['markdown']
  serialize: NonNullable<Editor['markdown']>['serialize'] | undefined
  blocks: readonly RichMarkdownCommentBlock[]
  counts: RichMarkdownCommentBlockCounts
}

// Keep only the current document per editor; scrolling changes geometry, not source lines.
const blocksByEditor = new WeakMap<Editor, RichMarkdownCommentBlocksSnapshot>()

export function getRichMarkdownCommentBlocks(editor: Editor): readonly RichMarkdownCommentBlock[] {
  const doc = editor.state.doc
  const markdown = editor.markdown
  const serialize = markdown?.serialize
  const cached = blocksByEditor.get(editor)
  if (cached?.doc === doc && cached.markdown === markdown && cached.serialize === serialize) {
    return cached.blocks
  }

  const counts =
    cached && cached.markdown === markdown && cached.serialize === serialize
      ? cached.counts
      : createCommentBlockCounts()
  const blocks = buildCommentBlocksWithCounts(editor, counts)
  blocksByEditor.set(editor, { doc, markdown, serialize, blocks, counts })
  return blocks
}
