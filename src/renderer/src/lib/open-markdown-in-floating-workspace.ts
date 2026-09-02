import type { MarkdownDocument } from '../../../shared/filesystem-entry-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import { detectLanguage } from './language-detect'

/**
 * Opens a markdown file that belongs to no workspace as a floating-workspace editor tab.
 *
 * Why local-only: every caller resolves an absolute path on this machine (a native picker or
 * the OS shell), so routing it through the active runtime would read it on the wrong host.
 */
export function openMarkdownDocumentInFloatingWorkspace(
  openFile: EditorFilesSlice['openFile'],
  document: MarkdownDocument,
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
