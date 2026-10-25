import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'

export function trackRichMarkdownLargePasteHistory(editor: Editor, onInterrupt: () => void) {
  const key = new PluginKey<boolean>('richMarkdownLargePasteHistory')
  let writingChunk = false
  let hasWrittenChunk = false
  let active = true
  let boundaryAtDisposal = false
  editor.registerPlugin(
    new Plugin({
      key,
      state: {
        init: () => false,
        apply(transaction, externalBoundaryStarted) {
          if (writingChunk || !hasWrittenChunk) {
            return false
          }
          if (transaction.docChanged && !externalBoundaryStarted) {
            onInterrupt()
          }
          return externalBoundaryStarted || transaction.docChanged
        }
      },
      filterTransaction(transaction, state) {
        // An external event may first change the document in an appended transaction.
        if (hasWrittenChunk && !writingChunk && transaction.docChanged && !key.getState(state)) {
          closeHistory(transaction)
        }
        return true
      }
    })
  )
  return {
    hasExternalBoundary(): boolean {
      return active ? key.getState(editor.state) === true : boundaryAtDisposal
    },
    dispatchChunk(transaction: Transaction): void {
      hasWrittenChunk = true
      writingChunk = true
      try {
        editor.view.dispatch(transaction)
      } finally {
        writingChunk = false
      }
    },
    dispose(): void {
      if (!active) {
        return
      }
      boundaryAtDisposal = !editor.isDestroyed && key.getState(editor.state) === true
      active = false
      if (!editor.isDestroyed) {
        editor.unregisterPlugin(key)
      }
    }
  }
}
