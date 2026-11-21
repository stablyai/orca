import type { Editor } from '@tiptap/react'
import { formatLineRangeReference } from '../../contextual-copy/selection-copy'
import { formatNativeChatQuote } from '../../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import { getRichMarkdownSelectionRange } from './rich-markdown-review-annotations'
import { getRichMarkdownSelectionVisibleText } from './rich-markdown-visible-text-map'
import { flushPendingProseMirrorSelection } from './rich-markdown-selection-flush'

function selectedMarkdown(editor: Editor): string {
  const { from, to } = editor.state.selection
  try {
    const content = editor.state.doc.slice(from, to).content.toJSON()
    const markdown = editor.markdown?.serialize({ type: 'doc', content })?.trim()
    if (markdown) {
      return markdown
    }
  } catch {
    // A slice of table cells or other non-block nodes has no Markdown of its own.
  }
  return getRichMarkdownSelectionVisibleText(editor.state).trim()
}

/** The selection as the chat quote a source editor would give: `path:lines` and its Markdown. */
export function richMarkdownSelectionAgentQuote(
  editor: Editor,
  relativePath: string,
  sourceLineOffset: number
): string | null {
  // A chord can precede ProseMirror's own sync of a mouse selection.
  flushPendingProseMirrorSelection(editor)
  if (editor.state.selection.empty) {
    return null
  }
  const text = selectedMarkdown(editor)
  if (!text) {
    return null
  }
  const range = getRichMarkdownSelectionRange(editor)
  const startLine = (range.startLine ?? range.lineNumber) + sourceLineOffset
  const endLine = range.lineNumber + sourceLineOffset
  return formatNativeChatQuote(
    formatLineRangeReference(relativePath, startLine, endLine, text, 'markdown')
  )
}
