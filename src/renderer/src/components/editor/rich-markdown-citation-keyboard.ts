import type { Editor } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'

export function handleRichMarkdownCitationKey({
  editor,
  event,
  linkBubbleOwnerId,
  onOpen
}: {
  editor: Editor | null
  event: KeyboardEvent
  linkBubbleOwnerId: string
  onOpen?: () => boolean
}): boolean {
  const selection = editor?.state?.selection
  if (
    !(selection instanceof NodeSelection) ||
    selection.node.type.name !== 'richMarkdownHtmlSuperscriptLink' ||
    event.isComposing ||
    editor?.view.composing === true
  ) {
    return false
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    return onOpen?.() ?? true
  }
  if (event.key !== 'Tab' || event.shiftKey) {
    return false
  }
  const firstAction = document.querySelector<HTMLButtonElement>(
    `[data-rich-markdown-link-bubble-owner="${linkBubbleOwnerId}"] button:not([disabled])`
  )
  if (!firstAction) {
    return false
  }
  event.preventDefault()
  firstAction.focus()
  return true
}
