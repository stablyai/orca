import type { ClipboardEvent } from 'react'
import { markdownMathSelectionText } from '../../../../shared/markdown-math-selection'

export function copyChatMathSelection(event: ClipboardEvent<HTMLDivElement>): void {
  if (event.defaultPrevented) {
    return
  }
  const selection = event.currentTarget.ownerDocument.getSelection()
  const text = selection && markdownMathSelectionText(selection, event.currentTarget)
  if (text === null || text === undefined) {
    return
  }
  event.clipboardData.setData('text/plain', text)
  event.clipboardData.setData('text/html', '')
  event.preventDefault()
}
