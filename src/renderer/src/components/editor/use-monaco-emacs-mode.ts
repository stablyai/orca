import { useEffect, type RefObject } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { createEmacsEditorHooks } from './emacs-window-commands'
import { installMonacoEmacsMode } from './monaco-emacs-mode'

export type MonacoEmacsModeProps = {
  fileId: string
  worktreeId?: string
  viewStateId?: string
  onSave: (content: string) => void
}

/** Mirrors the Vim effect's lifecycle, including the guard for an editor that unmounts during the lazy import. */
export function useMonacoEmacsMode(args: {
  editor: monacoEditor.IStandaloneCodeEditor | null
  enabled: boolean
  statusBarRef: RefObject<HTMLElement | null>
  propsRef: RefObject<MonacoEmacsModeProps>
}): void {
  const { editor, enabled, statusBarRef, propsRef } = args
  useEffect(() => {
    const statusNode = statusBarRef.current
    if (!editor || !enabled || !statusNode) {
      return
    }
    let cancelled = false
    let controller: { dispose: () => void } | null = null
    const hooks = createEmacsEditorHooks(
      () => {
        const current = propsRef.current
        return current?.worktreeId && current.viewStateId
          ? {
              fileId: current.fileId,
              worktreeId: current.worktreeId,
              viewStateId: current.viewStateId
            }
          : null
      },
      () => propsRef.current?.onSave(editor.getValue())
    )
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
  }, [editor, enabled, propsRef, statusBarRef])
}
