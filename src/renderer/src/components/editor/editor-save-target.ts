import type { OpenFile } from '@/store/slices/editor'

export function getEditorSaveTargetFile(
  activeFile: OpenFile,
  openFiles: OpenFile[]
): OpenFile | null {
  if (activeFile.mode !== 'markdown-preview') {
    return activeFile
  }
  return (
    openFiles.find(
      (openFile) =>
        openFile.id === activeFile.markdownPreviewSourceFileId && openFile.mode === 'edit'
    ) ?? null
  )
}
