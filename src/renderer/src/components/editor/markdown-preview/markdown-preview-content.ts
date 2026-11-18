import type { OpenFile } from '@/store/slices/editor/types/open-file'

/** A preview renders its source tab's unsaved buffer when that tab is open, otherwise the file on disk. */
export function markdownPreviewContent(
  preview: Pick<OpenFile, 'markdownPreviewSourceFileId' | 'filePath'>,
  editBuffers: Record<string, string>,
  diskContent: string
): { sourceFileId: string; content: string } {
  const sourceFileId = preview.markdownPreviewSourceFileId ?? preview.filePath
  return { sourceFileId, content: editBuffers[sourceFileId] ?? diskContent }
}
