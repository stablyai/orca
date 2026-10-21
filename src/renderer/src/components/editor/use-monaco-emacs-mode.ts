import { useEffect, type RefObject } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { createEmacsEditorHooks } from './emacs-window-commands'
import { installMonacoEmacsMode } from './monaco-emacs-mode'

/** The MonacoEditor props the Emacs table reads per key; held in a ref so handlers never go stale. */
export type MonacoEmacsModeProps = {
  fileId: string
  worktreeId?: string
  viewStateId?: string
  onSave: (content: string) => void
}

/**
 * Same lifecycle as the Vim effect in MonacoEditor: attach on mount or when the preset flips on,
 * dispose on the way out, and guard the lazy import against an editor that unmounted meanwhile.
 * `C-x C-s` routes to Orca's save like `:w` does; the window commands read the live view ids.
 */
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
    void installMonacoEmacsMode(editor, statusNode, hooks)
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
