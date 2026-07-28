import { useCallback, useRef, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { getEditorHeaderCopyState } from './editor-header-copy-state'

type UseEditorCopyPathResult = {
  copiedPathToast: { fileId: string; token: number } | null
  handleCopyPath: () => Promise<void>
}

export function useEditorCopyPath(activeFile: OpenFile | null): UseEditorCopyPathResult {
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )
  const copiedPathToastResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pathCopyMountedRef = useRef(true)

  const clearCopiedPathToastResetTimer = useCallback(() => {
    if (copiedPathToastResetTimerRef.current !== null) {
      clearTimeout(copiedPathToastResetTimerRef.current)
      copiedPathToastResetTimerRef.current = null
    }
  }, [])

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!activeFile) {
      return
    }
    const copyState = getEditorHeaderCopyState(activeFile)
    if (!copyState.copyText) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(copyState.copyText)
      if (!pathCopyMountedRef.current) {
        return
      }
      clearCopiedPathToastResetTimer()
      const nextToast = { fileId: activeFile.id, token: Date.now() }
      setCopiedPathToast(nextToast)
      copiedPathToastResetTimerRef.current = window.setTimeout(() => {
        copiedPathToastResetTimerRef.current = null
        setCopiedPathToast((current) => (current?.token === nextToast.token ? null : current))
      }, 1500)
    } catch {
      if (!pathCopyMountedRef.current) {
        return
      }
      clearCopiedPathToastResetTimer()
      setCopiedPathToast(null)
    }
  }, [activeFile, clearCopiedPathToastResetTimer])

  return { copiedPathToast, handleCopyPath }
}
