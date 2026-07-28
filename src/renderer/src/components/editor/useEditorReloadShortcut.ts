import { useEffect } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { editorShortcutMatches } from './editor-shortcuts'

type UseEditorReloadShortcutParams = {
  activeFile: OpenFile | null
  canReloadFromDisk: boolean
  handleReloadFromDisk: () => void
}

export function useEditorReloadShortcut({
  activeFile,
  canReloadFromDisk,
  handleReloadFromDisk
}: UseEditorReloadShortcutParams): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!activeFile || !canReloadFromDisk) {
        return
      }
      if (!editorShortcutMatches('editor.reloadFromDisk', event)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) {
        handleReloadFromDisk()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [activeFile, canReloadFromDisk, handleReloadFromDisk])
}
