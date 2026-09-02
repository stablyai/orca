import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'

export type RestoredEditorOwnerMigration = {
  fileId: string
  targetWorktreeId: string
  targetRelativePath: string
  targetExecutionHostId: ExecutionHostId
  targetRuntimeEnvironmentId: string | null
  targetOperationProvenance: EditorFileOperationProvenance
}

export type RestoredEditorOwnerResult =
  | { ok: true; fileId: string }
  | { ok: false; reason: 'collision' | 'owner-changed' | 'stale' }
