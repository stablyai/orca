import {
  normalizeMarkdownDefaultViewMode,
  type MarkdownDefaultViewMode
} from './markdown-default-view-mode'

/** Context-menu commands that set the persisted default Markdown view, keyed by the view they select. */
export const richMarkdownDefaultViewCommands = {
  source: 'default-view-source',
  rich: 'default-view-rich',
  preview: 'default-view-preview'
} as const satisfies Record<MarkdownDefaultViewMode, string>

export type RichMarkdownDefaultViewCommand =
  (typeof richMarkdownDefaultViewCommands)[MarkdownDefaultViewMode]

export type RichMarkdownContextMenuCommand =
  | RichMarkdownDefaultViewCommand
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

export function markdownDefaultViewForCommand(
  command: RichMarkdownContextMenuCommand
): MarkdownDefaultViewMode | null {
  const match = Object.entries(richMarkdownDefaultViewCommands).find(
    ([, candidate]) => candidate === command
  )
  return match ? normalizeMarkdownDefaultViewMode(match[0]) : null
}

export const richMarkdownContextMenuCommandChannel = 'rich-markdown:context-command'
export const richMarkdownContextMenuTargetChannel = 'rich-markdown:context-target'
/** Mirrors the persisted default Markdown view into main so the native menu can check the active radio item. */
export const markdownDefaultViewModeChannel = 'rich-markdown:default-view-mode'
