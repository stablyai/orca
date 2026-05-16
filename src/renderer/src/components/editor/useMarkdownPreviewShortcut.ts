import { useEffect, type RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import type { OpenFile } from '@/store/slices/editor'
import { canOpenMarkdownPreview, isMarkdownPreviewShortcut } from './markdown-preview-controls'

type UseMarkdownPreviewShortcutParams = {
  activeFile: OpenFile | null
  panelRef: RefObject<HTMLDivElement | null>
  isMac: boolean
  openMarkdownPreview: (file: {
    filePath: string
    relativePath: string
    worktreeId: string
    runtimeEnvironmentId?: string
    language: string
  }) => void
}

export function useMarkdownPreviewShortcut({
  activeFile,
  panelRef,
  isMac,
  openMarkdownPreview
}: UseMarkdownPreviewShortcutParams): void {
  const activeFilePath = activeFile?.filePath ?? null
  const activeFileRelativePath = activeFile?.relativePath ?? null
  const activeFileWorktreeId = activeFile?.worktreeId ?? null
  const activeFileMode = activeFile?.mode ?? null
  const activeFileDiffSource = activeFile?.diffSource
  const activeFileRuntimeEnvironmentId = activeFile?.runtimeEnvironmentId

  useEffect(() => {
    if (!activeFilePath || !activeFileRelativePath || !activeFileWorktreeId || !activeFileMode) {
      return
    }
    const shortcutLanguage =
      activeFileMode === 'diff'
        ? detectLanguage(activeFileRelativePath)
        : detectLanguage(activeFilePath)
    const canShowMarkdownPreview = canOpenMarkdownPreview({
      language: shortcutLanguage,
      mode: activeFileMode,
      diffSource: activeFileDiffSource
    })
    if (!canShowMarkdownPreview) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isMarkdownPreviewShortcut(event, isMac)) {
        return
      }
      const root = panelRef.current
      const target = event.target
      if (!root || !(target instanceof Node) || !root.contains(target)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      openMarkdownPreview({
        filePath: activeFilePath,
        relativePath: activeFileRelativePath,
        worktreeId: activeFileWorktreeId,
        runtimeEnvironmentId: activeFileRuntimeEnvironmentId,
        language: shortcutLanguage
      })
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [
    activeFileDiffSource,
    activeFileMode,
    activeFilePath,
    activeFileRelativePath,
    activeFileRuntimeEnvironmentId,
    activeFileWorktreeId,
    isMac,
    openMarkdownPreview,
    panelRef
  ])
}
