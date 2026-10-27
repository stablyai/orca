import type { FileDocument } from '../../../shared/filesystem-entry-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import { detectLanguage } from './language-detect'

/** Open picker/shell-resolved absolute local files in the floating workspace; focused runtime routing would read the wrong machine. */
export function openDocumentInFloatingWorkspace(
  openFile: EditorFilesSlice['openFile'],
  document: Pick<FileDocument, 'filePath' | 'relativePath'>,
  options: { targetGroupId?: string } = {}
): string {
  return openFile(
    {
      filePath: document.filePath,
      relativePath: document.relativePath,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: detectLanguage(document.relativePath),
      mode: 'edit',
      runtimeEnvironmentId: null
    },
    {
      preview: false,
      targetGroupId: options.targetGroupId,
      suppressActiveRuntimeFallback: true
    }
  )
}
