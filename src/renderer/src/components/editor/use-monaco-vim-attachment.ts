import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { attachMonacoVimMode, type VimAttachment } from './monaco-vim-mode'

export function useMonacoVimAttachment(args: {
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
