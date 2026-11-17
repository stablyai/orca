import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/workspace/identity/floating-workspace-id'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor/file-operations/editor-file-operation-provenance'
import { getEditorFileOperationContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { createUntitledMarkdownFile } from '@/lib/editor/file-operations/create-untitled-markdown'
import { requestNewFile } from '@/lib/editor/file-operations/new-file-request'
import { dirname, getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { createRuntimePath } from '@/runtime/files/mutations/runtime-file-mutation-client'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { EditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import { findGroupAndWorktree, findGroupForTab } from '../../tabs/tab-group-state'
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

/** Creates on the group's workspace host and opens the result; null means cancelled. */
export async function createUntitledFileInActiveWorkspace(
  get: EditorGet,
  groupId: string | undefined,
  create: (
    context: UntitledFileCreationContext
  ) => Promise<Parameters<EditorSlice['openFile']>[0] | null>,
  failureMessage: string
): Promise<boolean> {
  const state = get()
  const worktreeId =
    (groupId ? findGroupAndWorktree(state.groupsByWorktree, groupId)?.worktreeId : null) ??
    state.activeWorktreeId
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

/** Seeds `untitled<extension>` in the floating workspace for floating targets, else the active one. */
async function openSeededUntitledFile(
  get: EditorGet,
  extension: string,
  readContent: () => Promise<string>,
  groupId?: string
): Promise<boolean> {
  const failureMessage = translate('auto.store.pluginNewFile.failed', "Couldn't create the file.")
  // An empty floating panel's + menu passes the workspace ID in place of a group ID.
  const emptyFloatingPanel = groupId === FLOATING_TERMINAL_WORKTREE_ID
  if (
    emptyFloatingPanel ||
    (groupId && findGroupForTab(get().groupsByWorktree, FLOATING_TERMINAL_WORKTREE_ID, groupId))
  ) {
    try {
      const directory = await window.api.app.getFloatingMarkdownDirectory()
      if (!directory) {
        return false
      }
      const fileInfo = await createUntitledMarkdownFile(
        directory,
        FLOATING_TERMINAL_WORKTREE_ID,
        undefined,
        { kind: 'local' },
        { newFile: { extension, content: await readContent() } }
      )
      get().openFile(fileInfo, {
        preview: false,
        targetGroupId: emptyFloatingPanel ? undefined : groupId,
        focusEditor: true,
        suppressActiveRuntimeFallback: true
      })
      return true
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, failureMessage))
      return false
    }
  }
  return createUntitledFileInActiveWorkspace(
    get,
    groupId,
    async (context) =>
      createUntitledMarkdownFile(
        context.worktreePath,
        context.worktreeId,
        context.connectionId,
        context.target,
        {
          newFile: { extension, content: await readContent() },
          operationProvenance: context.operationProvenance,
          expectedSshTargetId: context.expectedSshTargetId,
          expectedSshConnectionGeneration: context.expectedSshConnectionGeneration,
          expectedExecutionHostId: context.expectedExecutionHostId,
          assertOperationCurrent: context.assertOperationCurrent
        }
      ),
    failureMessage
  )
}

export function createPluginNewFileActions(
  _set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  | 'openNewPluginFileInActiveWorkspace'
  | 'openBlankFileInActiveWorkspace'
  | 'openNewFileInActiveWorkspace'
> {
  return {
    openNewFileInActiveWorkspace: async (groupId) => {
      await createUntitledFileInActiveWorkspace(
        get,
        groupId,
        async (context) => {
          const state = get()
          const activeFile = state.openFiles.find(
            (file) =>
              file.id === state.activeFileIdByWorktree[context.worktreeId] &&
              file.worktreeId === context.worktreeId
          )
          const activeDirectory = activeFile ? dirname(activeFile.filePath) : null
          const relativePath = await requestNewFile({
            worktreePath: context.worktreePath,
            initialDirectory:
              activeDirectory &&
              getRelativePathInsideRoot(activeDirectory, context.worktreePath) !== null
                ? activeDirectory
                : context.worktreePath,
            disableBrowse: context.target.kind !== 'local' || Boolean(context.connectionId),
            create: async (path) => {
              context.assertOperationCurrent()
              await createRuntimePath(context, joinPath(context.worktreePath, path), 'file')
            }
          })
          if (relativePath === null) {
            return null
          }
          context.assertOperationCurrent()
          return {
            filePath: joinPath(context.worktreePath, relativePath),
            relativePath,
            worktreeId: context.worktreeId,
            language: detectLanguage(relativePath),
            operationProvenance: context.operationProvenance,
            mode: 'edit'
          }
        },
        translate('auto.store.newFile.failed', "Couldn't create the file.")
      )
    },
    openNewPluginFileInActiveWorkspace: async (newFile, groupId) => {
      const readTemplate = window.api?.plugins?.readNewFileTemplate
      if (!readTemplate) {
        return
      }
      await openSeededUntitledFile(
        get,
        newFile.extension,
        async () => {
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
          return content
        },
        groupId
      )
    },
    openBlankFileInActiveWorkspace: async (extension) => {
      await openSeededUntitledFile(get, extension, async () => '')
    }
  }
}
