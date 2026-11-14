import type { ClipboardEvent } from 'react'
import { copyMarkdownMathSelection } from '../../../../shared/markdown-math-selection'

export function copyChatMathSelection(event: ClipboardEvent<HTMLDivElement>): void {
  copyMarkdownMathSelection(event, event.currentTarget)
}
