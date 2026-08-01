import type { Editor } from '@tiptap/react'

export type RichMarkdownTableAction =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'delete-column'

export function runRichMarkdownTableAction(
  editor: Editor,
  action: RichMarkdownTableAction
): boolean {
  const chain = editor.chain().focus()

  switch (action) {
    case 'insert-row-above':
      return chain.addRowBefore().run()
    case 'insert-row-below':
      return chain.addRowAfter().run()
    case 'delete-row':
      return chain.deleteRow().run()
    case 'insert-column-left':
      return chain.addColumnBefore().run()
    case 'insert-column-right':
      return chain.addColumnAfter().run()
    case 'delete-column':
      return chain.deleteColumn().run()
  }
}
