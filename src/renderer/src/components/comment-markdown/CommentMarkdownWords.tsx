import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { markdownWordTokens } from './comment-markdown-word-fade'

/** Reading the selection flushes layout, so one listener keeps the selected range. A Range is
 *  live, so testing it against a node later touches only the DOM tree. */
let selectedRange: Range | null = null
let rangeWatchers = 0
function readDocumentRange(): void {
  const selection = document.getSelection()
  selectedRange =
    selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
}

/** Whether a selected range reaches the fading words in `root`, whose nodes it would lose if they
 *  merged into plain text; current while watched. */
export function isDocumentRangeInFadingWords(root: Element | null): boolean {
  const range = selectedRange
  if (root === null || range?.intersectsNode(root) !== true) {
    return false
  }
  for (const group of root.querySelectorAll('[data-word-group]')) {
    if (range.intersectsNode(group)) {
      return true
    }
  }
  return false
}

export function watchDocumentRange(): () => void {
  if (rangeWatchers++ === 0) {
    readDocumentRange()
    document.addEventListener('selectionchange', readDocumentRange)
  }
  return () => {
    if (--rangeWatchers === 0) {
      document.removeEventListener('selectionchange', readDocumentRange)
    }
  }
}

/** A text node of a fading block: text before the fade window stays plain, and each word in the
 *  window is a span keyed by its offset, so it keeps its node as older words leave the window. */
export function CommentMarkdownWords({
  node,
  children,
  ...props
}: ComponentProps<'span'> & ExtraProps): React.ReactNode {
  const from = node?.properties.dataFadeFrom
  if (typeof from !== 'number') {
    return <span {...props}>{children}</span>
  }
  const text = String(children ?? '')
  const start = Number(node?.properties.dataFadeOffset ?? 0) + from
  return (
    <span data-word-group="">
      {text.slice(0, from)}
      {markdownWordTokens(text.slice(from)).map(({ value, offset }) =>
        value.trim() === '' ? (
          value
        ) : (
          <span key={start + offset} data-word="">
            {value}
          </span>
        )
      )}
    </span>
  )
}
