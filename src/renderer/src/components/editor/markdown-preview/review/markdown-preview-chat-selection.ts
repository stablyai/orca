import { fencedCode } from '../../selection-copy'
import type { QuotableSelection } from '../../../native-chat/SelectionAddToChatPopover'

function sourceBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  const block = element?.closest<HTMLElement>('[data-source-line][data-source-end-line]') ?? null
  return block && root.contains(block) ? block : null
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
  const selected = selection.toString().trim()
  if (!root.contains(range.commonAncestorContainer) || selected === '') {
    return null
  }
  const blocks = [sourceBlock(range.startContainer, root), sourceBlock(range.endContainer, root)]
  const starts = blocks.map((block) => Number(block?.dataset.sourceLine))
  const ends = blocks.map((block) => Number(block?.dataset.sourceEndLine))
  if (![...starts, ...ends].every((line) => Number.isInteger(line) && line > 0)) {
    return { text: `${relativePath}\n${fencedCode(selected)}`, range }
  }
  const start = Math.min(...starts)
  const end = Math.max(...ends)
  const lines = content
    .split(/\r?\n/)
    .slice(start - 1, end)
    .join('\n')
  const label = start === end ? `${start}` : `${start}-${end}`
  return { text: `${relativePath}:${label}\n${fencedCode(lines, 'md')}`, range }
}
