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
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'image'
  | 'divider'

export type RichMarkdownContextMenuCommandPayload = {
  command: RichMarkdownContextMenuCommand
  x: number
  y: number
}

export const richMarkdownContextMenuCommandChannel = 'rich-markdown:context-command'
