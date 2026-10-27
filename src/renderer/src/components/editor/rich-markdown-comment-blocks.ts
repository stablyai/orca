import type { Editor, JSONContent } from '@tiptap/core'
import { countRichMarkdownReviewMarkdownLines } from './rich-markdown-review-line-count'

export type RichMarkdownCommentBlock = {
  key: string
  startLine: number
  endLine: number
  from: number
  to: number
}

function serializeRichMarkdownJson(editor: Editor, content: JSONContent[]): string {
  return (editor.markdown?.serialize({ type: 'doc', content }) ?? '').trimEnd()
}

export function buildRichMarkdownCommentBlocks(editor: Editor): RichMarkdownCommentBlock[] {
  const jsonContent = editor.getJSON().content ?? []
  const blocks: RichMarkdownCommentBlock[] = []
  let nextLine = 1
  let previousNodeJson: JSONContent | null = null
  let previousNodeLineCount = 0

  editor.state.doc.forEach((node, nodeOffset, index) => {
    const nodeJson = jsonContent[index]
    if (!nodeJson) {
      return
    }
    const nodeMarkdown = serializeRichMarkdownJson(editor, [nodeJson])
    const nodeLineCount = countRichMarkdownReviewMarkdownLines(nodeMarkdown)
    if (previousNodeJson) {
      const pairMarkdown = serializeRichMarkdownJson(editor, [previousNodeJson, nodeJson])
      const separatorLineCount = Math.max(
        0,
        countRichMarkdownReviewMarkdownLines(pairMarkdown) - previousNodeLineCount - nodeLineCount
      )
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

  const blocks = buildRichMarkdownCommentBlocks(editor)
  blocksByEditor.set(editor, { doc, markdown, serialize, blocks })
  return blocks
}
