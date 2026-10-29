import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from '@/lib/editor-file-operation-owner'
import {
  createUntitledMarkdownFile,
  type UntitledMarkdownFileInfo
} from '@/lib/create-untitled-markdown'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'

export type UntitledFileCreationContext = {
  worktreePath: string
  worktreeId: string
  connectionId: string | undefined
  target: RuntimeClientTarget
  operationProvenance: EditorFileOperationProvenance
  expectedSshConnectionGeneration?: number
  expectedSshTargetId?: string
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  assertOperationCurrent: () => void
}

/** Creates an untitled file at the active workspace's root on its own host (local, SSH or a
 *  runtime) and opens it; null from `create` means the user cancelled. */
export async function createUntitledFileInActiveWorkspace(
  get: EditorGet,
  groupId: string | undefined,
  create: (context: UntitledFileCreationContext) => Promise<UntitledMarkdownFileInfo | null>,
  failureMessage: string
): Promise<boolean> {
  const state = get()
  const worktreeId = state.activeWorktreeId
  const worktree = worktreeId ? state.getKnownWorktreeById(worktreeId) : undefined
  if (!worktreeId || !worktree) {
    return false
  }
  try {
    const operationProvenance = captureEditorFileOperationProvenance(
      state,
      worktreeId,
      undefined,
      false
    )
    const operationContext = getEditorFileOperationContext(
      state,
      { worktreeId, operationProvenance },
      worktree.path
    )
    const fileInfo = await create({
      worktreePath: worktree.path,
      worktreeId,
      connectionId: operationContext.connectionId,
      target: operationContext.target,
      operationProvenance,
      expectedSshConnectionGeneration: operationContext.expectedSshConnectionGeneration,
      expectedSshTargetId: operationContext.expectedSshTargetId,
      expectedExecutionHostId: operationContext.expectedExecutionHostId,
      assertOperationCurrent: () =>
        assertEditorFileOperationCurrent(get(), worktreeId, operationProvenance)
    })
    if (!fileInfo) {
      return false
    }
    get().openFile(fileInfo, { preview: false, targetGroupId: groupId, focusEditor: true })
    return true
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, failureMessage))
    return false
  }
}

export function createPluginNewFileActions(
  _set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openNewPluginFileInActiveWorkspace'> {
  return {
    openNewPluginFileInActiveWorkspace: async (newFile, groupId) => {
      const readTemplate = window.api?.plugins?.readNewFileTemplate
      if (!readTemplate) {
        return
      }
      await createUntitledFileInActiveWorkspace(
        get,
        groupId,
        async (context) => {
          const content = await readTemplate({
            pluginKey: newFile.pluginKey,
            newFileId: newFile.id
          })
          if (content === null) {
            throw new Error(
              translate(
                'auto.store.pluginNewFile.unavailable',
                '{{value0}} is no longer available. Turn its plugin back on.',
                { value0: newFile.title }
              )
            )
          }
          return createUntitledMarkdownFile(
            context.worktreePath,
            context.worktreeId,
            context.connectionId,
            context.target,
            {
              newFile: { extension: newFile.extension, content },
              operationProvenance: context.operationProvenance,
              expectedSshTargetId: context.expectedSshTargetId,
              expectedSshConnectionGeneration: context.expectedSshConnectionGeneration,
              expectedExecutionHostId: context.expectedExecutionHostId,
              assertOperationCurrent: context.assertOperationCurrent
            }
          )
        },
        translate('auto.store.pluginNewFile.failed', "Couldn't create the file.")
      )
    }
  }
}
