import type { Editor } from '@tiptap/react'

const RICH_MARKDOWN_CODE_BLOCK_INDENT = '  '

const LEADING_INDENT = /^(\t| {1,2})/

function changeCodeBlockIndent(editor: Editor, direction: 'indent' | 'outdent'): boolean {
  const { from, to, empty } = editor.state.selection
  const tr = editor.state.tr
  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'codeBlock') {
      return true
    }
    let lineStart = position + 1
    for (const line of node.textContent.split('\n')) {
      const lineEnd = lineStart + line.length
      const isTouched = lineEnd >= from && (empty ? lineStart <= to : lineStart < to)
      if (isTouched) {
        const start = tr.mapping.map(lineStart)
        if (direction === 'indent') {
          tr.insertText(RICH_MARKDOWN_CODE_BLOCK_INDENT, start)
        } else {
          const indent = LEADING_INDENT.exec(line)
          if (indent) {
            tr.delete(start, tr.mapping.map(lineStart + indent[0].length))
          }
        }
      }
      lineStart = lineEnd + 1
    }
    return false
  })
  if (!tr.docChanged) {
    return false
  }
  editor.view.dispatch(tr)
  return true
}

export function indentRichMarkdownCodeBlock(editor: Editor): boolean {
  if (editor.state.selection.empty) {
    return editor.commands.insertContent(RICH_MARKDOWN_CODE_BLOCK_INDENT)
  }
  return changeCodeBlockIndent(editor, 'indent')
}

function selectionStartsInCodeBlock(editor: Editor): boolean {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'codeBlock') {
      return true
    }
  }
  return false
}

export function outdentRichMarkdownCodeBlock(editor: Editor): boolean {
  // Selections that start outside code (e.g. list items wrapping a code block) belong to list outdent.
  if (!selectionStartsInCodeBlock(editor) && !editor.isActive('codeBlock')) {
    return false
  }
  return changeCodeBlockIndent(editor, 'outdent')
}
