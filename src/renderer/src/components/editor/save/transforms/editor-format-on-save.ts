import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRelativePathInsideWorktree,
  withSshMutationExpectation
} from '@/runtime/files/runtime-file-routing'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { assertRemoteWriteFitsOneRequest } from '@/runtime/files/mutations/runtime-file-mutation-client'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import type { EditorFormatResult } from '../../../../../../shared/editor-formatter'
import type { AppStoreApi } from '../queue/editor-save-queue-contract'
import type { EditorSaveTrigger } from '../queue/editor-save-disk-precondition'
import { hasEditorBytesDraft } from '../bytes/editor-bytes-documents'
import { adoptEditorSaveText } from './editor-save-text-transform'

export function editorFormatOnSave(
  store: AppStoreApi,
  file: OpenFile,
  context: RuntimeFileOperationArgs,
  trigger: EditorSaveTrigger,
  text: string,
  assertCurrent: () => void
): Promise<string> | null {
  const worktreeId = context.worktreeId
  if (
    store.getState().settings?.editorFormatOnSave !== true ||
    trigger === 'restart' ||
    hasEditorBytesDraft(file.id) ||
    !worktreeId
  ) {
    return null
  }
  const relativePath = getRelativePathInsideWorktree(context.worktreePath, file.filePath)
  if (relativePath === null) {
    return null
  }
  const recordId = editorBufferIdOfView(store.getState(), file.id)
  return (async () => {
    let result: EditorFormatResult
    try {
      if (context.target.kind === 'environment') {
        assertRemoteWriteFitsOneRequest(text)
      }
      result = await callRuntimeRpc<EditorFormatResult>(
        context.target,
        'files.formatText',
        withSshMutationExpectation(context, {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          relativePath,
          content: text
        }),
        {
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: context.expectedEnvironmentPairingRevision,
          beforeSend: assertCurrent
        }
      )
    } catch (error) {
      assertCurrent()
      toast.error(
        translate(
          'components.editor.formatOnSave.failed',
          'Could not format {{file}}. Saving without formatting: {{reason}}',
          {
            file: file.relativePath,
            reason: error instanceof Error ? error.message : String(error)
          }
        ),
        { id: `format-on-save:${file.id}` }
      )
      return text
    }
    assertCurrent()
    return result.kind === 'formatted'
      ? adoptEditorSaveText(store, recordId, text, result.text, assertCurrent)
      : text
  })()
}
