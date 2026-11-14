import React, { useRef, useState, useCallback } from 'react'
import type { editor } from 'monaco-editor'
import { setupContextualCopy } from './setup-contextual-copy'
import { useTranslate } from '@/i18n/use-translate'

export function useContextualCopySetup() {
  const t = useTranslate()
  const [copyToast, setCopyToast] = useState<{ left: number; top: number } | null>(null)
  const copyToastTimeoutRef = useRef<number | null>(null)

  const setupCopy = useCallback(
    (
      editorInstance: editor.IStandaloneCodeEditor,
      _monaco: unknown,
      filePath: string,
      propsRef: React.MutableRefObject<{
        relativePath: string
        language: string
        onSave?: (content: string) => void
      }>
    ) => {
      setupContextualCopy({
        editorInstance,
        filePath,
        setCopyToast,
        propsRef,
        copyToastTimeoutRef
      })
    },
    []
  )

  const toastNode = copyToast ? (
    <div
      className="pointer-events-none fixed z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
      style={{ left: copyToast.left, top: copyToast.top }}
    >
      {t('auto.components.editor.useContextualCopySetup.059bfb0d94', 'Context copied')}
    </div>
  ) : null

  return { setupCopy, toastNode }
}
