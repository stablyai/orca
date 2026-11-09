import { useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { resolveEditorKeybindings } from '../../../../shared/editor-keybindings'
import { attachMonacoVimMode, shouldAttachEditorVim, type VimAttachment } from './monaco-vim-mode'

const VIM_STATUS_CLASS =
  'min-h-6 shrink-0 border-t border-border bg-editor-surface px-2 text-xs text-muted-foreground'

function useMonacoVimAttachment(args: {
  editor: editor.IStandaloneCodeEditor | null
  enabled: boolean
  onWrite: () => void
  statusNode: HTMLElement | null
}): void {
  const onWriteRef = useRef(args.onWrite)
  onWriteRef.current = args.onWrite
  const { editor: editorInstance, enabled, statusNode } = args

  useEffect(() => {
    if (!enabled || !editorInstance || !statusNode) {
      return
    }

    const controller = new AbortController()
    let disposed = false
    let attachment: VimAttachment | null = null
    let layoutFrame = 0

    void attachMonacoVimMode({
      editor: editorInstance,
      statusNode,
      onWriteRef,
      signal: controller.signal
    })
      .then((next) => {
        if (disposed) {
          next.dispose()
          return
        }
        attachment = next
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0
          editorInstance.layout()
        })
      })
      .catch(() => {
        // Why: attach already logged and disposed; an effect rejection must not go unhandled.
      })

    return () => {
      disposed = true
      controller.abort()
      if (layoutFrame !== 0) {
        cancelAnimationFrame(layoutFrame)
      }
      attachment?.dispose()
    }
  }, [editorInstance, enabled, statusNode])
}

export function EditorVimStatusRow(args: {
  editor: editor.IStandaloneCodeEditor | null
  preset: string | undefined
  readOnly: boolean
  autoHeight: boolean
  onWrite: () => void
}): React.JSX.Element | null {
  const enabled = shouldAttachEditorVim({
    preset: resolveEditorKeybindings(args.preset),
    readOnly: args.readOnly,
    autoHeight: args.autoHeight
  })
  const [statusNode, setStatusNode] = useState<HTMLElement | null>(null)
  useMonacoVimAttachment({
    editor: args.editor,
    enabled,
    statusNode,
    onWrite: args.onWrite
  })
  if (!enabled) {
    return null
  }
  return <div ref={setStatusNode} data-vim-status aria-live="polite" className={VIM_STATUS_CLASS} />
}
