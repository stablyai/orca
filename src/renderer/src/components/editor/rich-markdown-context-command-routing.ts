import type { Editor } from '@tiptap/react'
import type {
  RichMarkdownContextMenuCommand,
  RichMarkdownContextMenuCommandPayload
} from '../../../../shared/rich-markdown-context-menu'

export function runRichMarkdownContextCommand({
  command,
  editor,
  toggleLink,
  pickImage
}: {
  command: RichMarkdownContextMenuCommand
  editor: Editor
  toggleLink: () => void
  pickImage: () => void
}): void {
  switch (command) {
    case 'add-link':
      toggleLink()
      return
    case 'bold':
      editor.chain().focus().toggleBold().run()
      return
    case 'italic':
      editor.chain().focus().toggleItalic().run()
      return
    case 'strike':
      editor.chain().focus().toggleStrike().run()
      return
    case 'inline-code':
      editor.chain().focus().toggleCode().run()
      return
    case 'code-block':
      editor.chain().focus().toggleCodeBlock().run()
      return
    case 'blockquote':
      editor.chain().focus().toggleBlockquote().run()
      return
    case 'paragraph':
      editor.chain().focus().setParagraph().run()
      return
    case 'heading-1':
      editor.chain().focus().setHeading({ level: 1 }).run()
      return
    case 'heading-2':
      editor.chain().focus().setHeading({ level: 2 }).run()
      return
    case 'heading-3':
      editor.chain().focus().setHeading({ level: 3 }).run()
      return
    case 'bullet-list':
      editor.chain().focus().toggleBulletList().run()
      return
    case 'ordered-list':
      editor.chain().focus().toggleOrderedList().run()
      return
    case 'task-list':
      editor.chain().focus().toggleTaskList().run()
      return
    case 'image':
      pickImage()
      return
    case 'divider':
      editor.chain().focus().setHorizontalRule().run()
  }
}

export function isRichMarkdownContextCommandTarget(
  payload: RichMarkdownContextMenuCommandPayload,
  root: HTMLElement | null
): boolean {
  if (!root) {
    return false
  }
  const rect = root.getBoundingClientRect()
  return (
    payload.x >= rect.left &&
    payload.x <= rect.right &&
    payload.y >= rect.top &&
    payload.y <= rect.bottom
  )
}
