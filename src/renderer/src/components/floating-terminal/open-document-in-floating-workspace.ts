import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'

/** Place an owner-resolved document in floating; omitted ownership stays client-local without active-runtime fallback. */
export function openDocumentInFloatingWorkspace(
  openFile: EditorFilesSlice['openFile'],
  document: Pick<OpenFile, 'filePath' | 'relativePath'> &
    Partial<
      Pick<
        OpenFile,
        | 'worktreeId'
        | 'runtimeEnvironmentId'
        | 'externalSshTargetId'
        | 'terminalArtifactGrantId'
        | 'operationProvenance'
        | 'readOnly'
      >
    >,
  options: { targetGroupId?: string; executionHostId?: ExecutionHostId } = {}
): string {
  return openFile(
    {
      ...document,
      worktreeId: document.worktreeId ?? FLOATING_TERMINAL_WORKTREE_ID,
      language: detectLanguage(document.relativePath),
      mode: 'edit',
      runtimeEnvironmentId: document.runtimeEnvironmentId ?? null
    },
    {
      preview: false,
      placementWorkspaceId: FLOATING_TERMINAL_WORKTREE_ID,
      executionHostId: options.executionHostId,
      targetGroupId: options.targetGroupId,
      suppressActiveRuntimeFallback: !document.runtimeEnvironmentId
    }
  )
}
