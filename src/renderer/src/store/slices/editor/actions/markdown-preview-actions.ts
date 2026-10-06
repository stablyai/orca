import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from '@/lib/editor-file-operation-owner'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import type { OpenFile } from '../types/open-file'
import { resolveEditorFileIdForOwner } from '../file-ids/editor-file-ids'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import { canPickWorkspaceMarkdownDocument } from '@/lib/workspace-markdown-picker'
import { detectLanguage } from '@/lib/language-detect'

export function createMarkdownPreviewActions(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  | 'openNewMarkdownInActiveWorkspace'
  | 'openMarkdownFileInWorkspace'
  | 'openMarkdownPreview'
  | 'makePreviewFilePermanent'
  | 'pinFile'
> {
  return {
    openMarkdownFileInWorkspace: async (worktreeId, groupId) => {
      const state = get()
      if (
        state.activeWorktreeId !== worktreeId ||
        !canPickWorkspaceMarkdownDocument(state, worktreeId)
      ) {
        return
      }
      const worktree = state.getKnownWorktreeById(worktreeId)
      if (!worktree) {
        return
      }
      try {
        const provenance = captureEditorFileOperationProvenance(state, worktreeId, null, true)
        const document = await window.api.app.pickMarkdownDocument(worktree.path)
        if (!document) {
          return
        }
        const current = get()
        assertEditorFileOperationCurrent(current, worktreeId, provenance)
        // The chooser may outlive its workspace or split group.
        if (
          current.activeWorktreeId !== worktreeId ||
          !canPickWorkspaceMarkdownDocument(current, worktreeId) ||
          current.getKnownWorktreeById(worktreeId)?.path !== worktree.path ||
          !current.groupsByWorktree[worktreeId]?.some((group) => group.id === groupId)
        ) {
          return
        }
        current.openFile(
          {
            filePath: document.filePath,
            relativePath: document.relativePath,
            worktreeId,
            language: detectLanguage(document.relativePath),
            mode: 'edit',
            runtimeEnvironmentId: null
          },
          {
            preview: false,
            targetGroupId: groupId,
            focusEditor: true,
            suppressActiveRuntimeFallback: true
          }
        )
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, 'Failed to open markdown file.'))
      }
    },

    openNewMarkdownInActiveWorkspace: async (groupId) => {
      const state = get()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        return
      }
      const worktree = state.getKnownWorktreeById(worktreeId)
      if (!worktree) {
        return
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
        const fileInfo = await createUntitledMarkdownFileWithTemplateSelection(
          worktree.path,
          worktreeId,
          operationContext.connectionId,
          operationContext.settings,
          operationProvenance,
          operationContext.expectedSshConnectionGeneration,
          operationContext.expectedSshTargetId,
          operationContext.expectedExecutionHostId,
          () => assertEditorFileOperationCurrent(get(), worktreeId, operationProvenance)
        )
        if (!fileInfo) {
          return
        }
        get().openFile(fileInfo, {
          preview: false,
          targetGroupId: groupId,
          focusEditor: true
        })
        get().recordFeatureInteraction('markdown-file-created')
      } catch (err) {
        toast.error(extractIpcErrorMessage(err, 'Failed to create untitled markdown file.'))
      }
    },

    openMarkdownPreview: (file, options) => {
      const initialState = get()
      const resolvedRuntimeEnvironmentId =
        file.runtimeEnvironmentId === null
          ? null
          : (file.runtimeEnvironmentId ??
            initialState.settings?.activeRuntimeEnvironmentId?.trim() ??
            undefined)
      const sourceFileId =
        options?.sourceFileId ??
        resolveEditorFileIdForOwner(
          initialState,
          file.filePath,
          file.worktreeId,
          resolvedRuntimeEnvironmentId,
          ['edit']
        )
      const id = `markdown-preview::${sourceFileId}`
      const externalSshTargetId =
        file.externalSshTargetId ??
        initialState.openFiles.find((openFile) => openFile.id === sourceFileId)?.externalSshTargetId
      const anchor = options?.anchor || undefined
      set((s) => {
        const existing = s.openFiles.find((openFile) => openFile.id === id)
        const worktreeId = file.worktreeId
        const runtimeEnvironmentId = resolvedRuntimeEnvironmentId
        const activeResult = buildEditorActiveResult(s, worktreeId, id)

        if (existing) {
          const needsUpdate =
            existing.relativePath !== file.relativePath ||
            existing.filePath !== file.filePath ||
            existing.language !== file.language ||
            existing.externalSshTargetId !== externalSshTargetId ||
            existing.markdownPreviewSourceFileId !== sourceFileId ||
            existing.markdownPreviewAnchor !== anchor ||
            existing.mode !== 'markdown-preview'
          return needsUpdate
            ? {
                openFiles: s.openFiles.map((openFile) =>
                  openFile.id === id
                    ? {
                        ...openFile,
                        filePath: file.filePath,
                        relativePath: file.relativePath,
                        worktreeId: file.worktreeId,
                        language: file.language,
                        runtimeEnvironmentId,
                        externalSshTargetId,
                        markdownPreviewSourceFileId: sourceFileId,
                        markdownPreviewAnchor: anchor,
                        mode: 'markdown-preview' as const
                      }
                    : openFile
                ),
                ...activeResult
              }
            : activeResult
        }

        const newFile: OpenFile = {
          id,
          filePath: file.filePath,
          relativePath: file.relativePath,
          worktreeId: file.worktreeId,
          language: file.language,
          isDirty: false,
          runtimeEnvironmentId,
          externalSshTargetId,
          markdownPreviewSourceFileId: sourceFileId,
          markdownPreviewAnchor: anchor,
          mode: 'markdown-preview'
        }

        return {
          openFiles: [...s.openFiles, newFile],
          ...activeResult
        }
      })
      void openWorkspaceEditorItem(
        get(),
        id,
        file.worktreeId,
        `${file.relativePath} (preview)`,
        'editor',
        false,
        options?.targetGroupId
      )
    },

    makePreviewFilePermanent: (fileId, tabId) => {
      set((s) => {
        let changed = false
        const openFiles = s.openFiles.map((file) => {
          if (file.id !== fileId || !file.isPreview) {
            return file
          }
          changed = true
          return { ...file, isPreview: undefined }
        })
        const unifiedTabsByWorktree: typeof s.unifiedTabsByWorktree = {}
        for (const [worktreeId, tabs] of Object.entries(s.unifiedTabsByWorktree ?? {})) {
          unifiedTabsByWorktree[worktreeId] = tabs.map((tab) => {
            if (tab.entityId !== fileId || (tabId && tab.id !== tabId) || !tab.isPreview) {
              return tab
            }
            changed = true
            return { ...tab, isPreview: false }
          })
        }
        return changed ? { openFiles, unifiedTabsByWorktree } : s
      })
    },

    pinFile: (fileId, tabId) => {
      get().makePreviewFilePermanent(fileId, tabId)
      const state = get()
      for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
        for (const item of tabs) {
          if (item.entityId === fileId && (!tabId || item.id === tabId)) {
            state.pinTab?.(item.id)
          }
        }
      }
    }
  }
}
