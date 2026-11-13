import { fencedCode } from '../../selection-copy'
import type { QuotableSelection } from '../../../native-chat/selection-quotes/SelectionAddToChatPopover'
import { selectedTextEdges } from '../../../native-chat/selection-quotes/native-chat-quote-selection'

function sourceLines(node: Node, root: HTMLElement): [number, number] | null {
  const block = node.parentElement?.closest<HTMLElement>('[data-source-line][data-source-end-line]')
  const start = Number(block?.dataset.sourceLine)
  const end = Number(block?.dataset.sourceEndLine)
  return block && root.contains(block) && Number.isInteger(start) && start > 0 && end >= start
    ? [start, end]
    : null
}

/** The selected blocks' source lines under `path:start-end`, or the selected text when no block carries lines. */
export function readMarkdownPreviewChatSelection(
  root: HTMLElement,
  content: string,
  relativePath: string
): QuotableSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return null
  }
  const range = selection.getRangeAt(0)
  // Checked before reading any text: every mounted preview sees every selection in the window.
  if (!root.contains(range.commonAncestorContainer)) {
    return null
  }
  // Text edges, not range ends: a triple-click's range ends at the start of the next block.
  const edges = selectedTextEdges(range)
  const selected = selection.toString().trim()
  if (!edges || selected === '') {
    return null
  }
  const first = sourceLines(edges.first, root)
  const last = sourceLines(edges.last, root)
  if (!first || !last) {
    return { text: `${relativePath}\n${fencedCode(selected)}`, range }
  }
  const start = Math.min(first[0], last[0])
  const end = Math.max(first[1], last[1])
  const lines = content
    .split(/\r?\n/)
    .slice(start - 1, end)
    .join('\n')
  const label = start === end ? `${start}` : `${start}-${end}`
  return { text: `${relativePath}:${label}\n${fencedCode(lines, 'md')}`, range }
}
