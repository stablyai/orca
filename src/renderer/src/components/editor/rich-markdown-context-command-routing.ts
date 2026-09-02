import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import type { RichMarkdownContextMenuCommandPayload } from '../../../../shared/rich-markdown-context-menu'
import {
  runRichMarkdownTableAction,
  type RichMarkdownTableAction
} from './rich-markdown-table-actions'

export function isRichMarkdownTableContextCommand(
  command: RichMarkdownContextMenuCommandPayload['command']
): command is RichMarkdownTableAction {
  return (
    command === 'insert-row-above' ||
    command === 'insert-row-below' ||
    command === 'delete-row' ||
    command === 'insert-column-left' ||
    command === 'insert-column-right' ||
    command === 'delete-column' ||
    command === 'delete-table'
  )
}

export function runRichMarkdownContextCommand({
  payload,
  editor,
  toggleLink,
  pickImage
}: {
  payload: RichMarkdownContextMenuCommandPayload
  editor: Editor
  toggleLink: () => void
  pickImage: () => void
}): void {
  const { command } = payload
  if (!command.startsWith('insert-') && !command.startsWith('delete-')) {
    try {
      const clickPosition = editor.view.posAtCoords({ left: payload.x, top: payload.y })?.pos
      const selection = editor.state.selection
      if (
        clickPosition !== undefined &&
        (selection.empty || clickPosition < selection.from || clickPosition > selection.to)
      ) {
        editor.view.dispatch(
          editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(clickPosition)))
        )
      }
    } catch {
      return
    }
  }
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
    case 'heading-4':
      editor.chain().focus().setHeading({ level: 4 }).run()
      return
    case 'heading-5':
      editor.chain().focus().setHeading({ level: 5 }).run()
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
      return
    case 'insert-row-above':
    case 'insert-row-below':
    case 'delete-row':
    case 'insert-column-left':
    case 'insert-column-right':
    case 'delete-column':
    case 'delete-table':
      runRichMarkdownTableAction(editor, command, { clientX: payload.x, clientY: payload.y })
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
