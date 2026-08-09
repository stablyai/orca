import type { Editor } from '@tiptap/react'
import { getLinkBubblePosition } from './RichMarkdownLinkBubble'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import type { RichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import {
  createEditableMarkdownLinkBubble,
  getRichMarkdownSelectionLinkBubble
} from './rich-markdown-selected-link-actions'

export function handleRichMarkdownLinkShortcut({
  editor,
  event,
  htmlSuperscriptLinkContext,
  isEditing,
  isMac,
  root,
  setEditing,
  setLinkBubble
}: {
  editor: Editor | null
  event: KeyboardEvent
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
  isEditing: boolean
  isMac: boolean
  root: HTMLElement | null
  setEditing: (editing: boolean) => void
  setLinkBubble: (bubble: LinkBubbleState | null) => void
}): boolean {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!modifier || event.key.toLowerCase() !== 'k') {
    return false
  }
  event.preventDefault()
  if (!editor) {
    return true
  }
  if (isEditing) {
    setEditing(false)
    if (!editor.isActive('link')) {
      setLinkBubble(null)
    }
    editor.commands.focus()
    return true
  }
  // Why: NodeSelection on an HTML citation still has a bubble position, but
  // markdown setLink/unsetLink cannot edit that atom — open the citation
  // action bubble instead of the markdown edit field.
  const selectionBubble = getRichMarkdownSelectionLinkBubble(
    editor,
    root,
    htmlSuperscriptLinkContext
  )
  if (selectionBubble) {
    setLinkBubble(selectionBubble)
    setEditing(selectionBubble.kind === 'markdown')
    return true
  }
  const position = getLinkBubblePosition(editor, root)
  if (position) {
    setLinkBubble(createEditableMarkdownLinkBubble('', position))
    setEditing(true)
  }
  return true
}
