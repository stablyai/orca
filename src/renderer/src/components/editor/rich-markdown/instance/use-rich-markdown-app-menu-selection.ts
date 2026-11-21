import { useEffect } from 'react'
import type { Editor } from '@tiptap/react'
import type { MutableRefObject } from 'react'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  type AppMenuSelectionAction
} from '@/lib/app-commands/app-menu-selection-actions'

export function useRichMarkdownAppMenuSelection(
  rootRef: MutableRefObject<HTMLDivElement | null>,
  editorRef: MutableRefObject<Editor | null>
): void {
  useEffect(() => {
    const onSelectionAction = (event: Event): void => {
      const root = rootRef.current
      if (
        (event as CustomEvent<AppMenuSelectionAction>).detail !== 'select-all' ||
        root?.contains(document.activeElement) !== true
      ) {
        return
      }
      event.preventDefault()
      const editor = editorRef.current
      if (!editor || editor.isDestroyed || editor.view.composing) {
        return
      }
      editor.commands.selectAll()
    }

    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
    return () => window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction)
  }, [editorRef, rootRef])
}
