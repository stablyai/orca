import { useEffect, type RefObject } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { installMonacoEmacsMode } from './monaco-emacs-mode'

export function useMonacoEmacsMode(args: {
  editor: monacoEditor.IStandaloneCodeEditor | null
  enabled: boolean
  statusBarRef: RefObject<HTMLElement | null>
  propsRef: RefObject<{ onSave: (content: string) => void }>
}): void {
  const { editor, enabled, statusBarRef, propsRef } = args
  useEffect(() => {
    const statusNode = statusBarRef.current
    if (!editor || !enabled || !statusNode) {
      return
    }
    let cancelled = false
    let controller: { dispose: () => void } | null = null
    const hooks = { onSave: () => propsRef.current.onSave(editor.getValue()) }
    void installMonacoEmacsMode(editor, statusNode, hooks, () => cancelled)
      .then((installed) => {
        if (cancelled) {
          installed.dispose()
        } else {
          controller = installed
        }
      })
      .catch((error) => {
        console.error('Failed to enable Emacs keybindings', error)
      })
    return () => {
      cancelled = true
      controller?.dispose()
    }
  }, [editor, enabled, statusBarRef, propsRef])
}
