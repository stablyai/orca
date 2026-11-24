import type { Editor } from '@tiptap/react'

export function promptEditor(element: HTMLElement): Editor {
  return (element as HTMLElement & { editor: Editor }).editor
}
