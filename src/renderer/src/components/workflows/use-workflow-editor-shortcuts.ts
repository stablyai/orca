import { useEffect, type RefObject } from 'react'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { workflowEditorActions } from './workflow-editor-actions'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/** Editor shortcuts scoped to the page; fields keep their native text editing keys. */
export function useWorkflowEditorShortcuts(
  root: RefObject<HTMLElement | null>,
  onSave: () => void
): void {
  useEffect(() => {
    const element = root.current
    if (!element) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = isMac ? event.metaKey : event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && key === 's') {
        event.preventDefault()
        onSave()
        return
      }
      if (isTyping(event.target) || useWorkflowEditorStore.getState().mode === 'execution') {
        return
      }
      const store = useWorkflowEditorStore.getState()
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          store.redo()
        } else {
          store.undo()
        }
      } else if (mod && key === 'y' && !isMac) {
        event.preventDefault()
        store.redo()
      } else if (mod && key === 'c') {
        workflowEditorActions.copySelection()
      } else if (mod && key === 'v') {
        event.preventDefault()
        workflowEditorActions.paste()
      } else if (mod && key === 'd') {
        event.preventDefault()
        workflowEditorActions.duplicateSelection()
      } else if (mod && key === 'a') {
        event.preventDefault()
        workflowEditorActions.selectAll()
      } else if (!mod && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        workflowEditorActions.deleteSelection()
      } else if (event.key === 'Escape') {
        store.select(null)
      }
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [root, onSave])
}
