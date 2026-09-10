import type { Editor } from '@tiptap/react'

export const RICH_MARKDOWN_CODE_BLOCK_INDENT = '  '

const LEADING_INDENT = /^(\t| {1,2})/

function findCodeBlockAtCursor(editor: Editor): { text: string; start: number } | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === 'codeBlock') {
      return { text: node.textContent, start: $from.start(depth) }
    }
  }
  return null
}

/**
 * Shift+Tab inside a code block: strip one indent step from every line the
 * selection touches, mirroring Tab's insert.
 */
export function outdentRichMarkdownCodeBlock(editor: Editor): boolean {
  const codeBlock = findCodeBlockAtCursor(editor)
  if (!codeBlock) {
    return false
  }

  const { from, to } = editor.state.selection
  const tr = editor.state.tr
  let lineStart = codeBlock.start

  for (const line of codeBlock.text.split('\n')) {
    const lineEnd = lineStart + line.length
    const isTouched = lineEnd >= from && lineStart <= to
    const indent = isTouched ? LEADING_INDENT.exec(line) : null
    if (indent) {
      tr.delete(tr.mapping.map(lineStart), tr.mapping.map(lineStart + indent[0].length))
    }
    lineStart = lineEnd + 1
  }

  if (!tr.docChanged) {
    return false
  }
  editor.view.dispatch(tr)
  return true
}
