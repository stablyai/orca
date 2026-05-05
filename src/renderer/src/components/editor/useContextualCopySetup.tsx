import React, { useRef, useState, useEffect, useCallback } from 'react'
import type { editor } from 'monaco-editor'
import { setupContextualCopy } from './setup-contextual-copy'

export function useContextualCopySetup() {
  const [copyToast, setCopyToast] = useState<{ left: number; top: number } | null>(null)
  const copyToastTimeoutRef = useRef<number | null>(null)

  const isMac = navigator.userAgent.includes('Mac')
  const copyShortcutLabel = isMac ? '⌥⌘C' : 'Ctrl+Alt+C'

  useEffect(() => {
    const toastRef = copyToastTimeoutRef
    return () => {
      if (toastRef.current !== null) {
        window.clearTimeout(toastRef.current)
      }
    }
  }, [])

  const setupCopy = useCallback(
    (
      editorInstance: editor.IStandaloneCodeEditor,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      monaco: any,
      filePath: string,
      propsRef: React.MutableRefObject<{
        relativePath: string
        language: string
        onSave?: (content: string) => void
      }>
    ) => {
      setupContextualCopy({
        editorInstance,
        monaco,
        filePath,
        copyShortcutLabel,
        setCopyToast,
        propsRef,
        copyToastTimeoutRef
      })
    },
    [copyShortcutLabel]
  )

  const toastNode = copyToast ? (
    <div
      className="pointer-events-none fixed z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
      style={{ left: copyToast.left, top: copyToast.top }}
    >
      Context copied
    </div>
  ) : null

  return { setupCopy, toastNode }
}
