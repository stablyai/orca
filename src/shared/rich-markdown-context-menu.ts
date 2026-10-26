export type RichMarkdownContextMenuCommand =
  | 'add-link'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inline-code'
  | 'code-block'
  | 'blockquote'
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'image'
  | 'divider'
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'delete-column'
  | 'delete-table'
  | 'open-link-in-orca-browser'

export type RichMarkdownContextMenuCommandPayload = {
  command: RichMarkdownContextMenuCommand
  tableTargetId?: string
  x: number
  y: number
}

export type RichMarkdownContextMenuTableTarget = {
  cellType: 'body' | 'header'
  targetId: string
  x: number
  y: number
}

/** Sent before the native menu when the right-clicked rich-editor link can open in Orca Browser. */
export type RichMarkdownContextMenuLinkTarget = {
  x: number
  y: number
}

export const richMarkdownContextMenuCommandChannel = 'rich-markdown:context-command'
export const richMarkdownContextMenuTargetChannel = 'rich-markdown:context-target'
export const richMarkdownContextMenuLinkTargetChannel = 'rich-markdown:context-link-target'
// A contenteditable that is not a rich Markdown editor, such as the chat composer.
export const plainTextContextMenuTargetChannel = 'editable-context-menu:plain-text-target'
