import type { Editor } from '@tiptap/react'

type NativeSelectionSnapshot = {
  anchorNode: Node | null
  anchorOffset: number
  focusNode: Node | null
  focusOffset: number
}

type ProseMirrorDomObserver = {
  currentSelection?: {
    set?: (selection: NativeSelectionSnapshot) => void
  }
  flush?: () => void
}

type ProseMirrorViewWithDomObserver = Editor['view'] & {
  domObserver?: ProseMirrorDomObserver
}

export function flushPendingProseMirrorSelection(editor: Editor): void {
  let observer: ProseMirrorDomObserver | undefined
  try {
    observer = (editor.view as ProseMirrorViewWithDomObserver).domObserver
  } catch {
    return
  }

  if (typeof observer?.flush !== 'function') {
    return
  }

  // Why: immediate Tab after a mouse click can run before ProseMirror has
  // copied the native selection into editor state, so list commands hit stale item state.
  observer.currentSelection?.set?.({
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0
  })
  observer.flush()
}
