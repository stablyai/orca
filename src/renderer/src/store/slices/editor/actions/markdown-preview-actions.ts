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
import type { Tab } from '../../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { withPreviewEnded } from '../../tabs/tab-preview-flag'
import {
  previewEditorTabsOf,
  recordPromotedEditorTabsInLayoutOwner
} from '../tabs/editor-tab-layout-owner'

type FileReadAuthority = Pick<
  OpenFile,
  'externalSshTargetId' | 'terminalArtifactGrantId' | 'readOnly'
>

/** A preview reads its source's file, so it must read with the same host, grant and client-local flag (#31034). */
function inheritFileReadAuthority(
  file: FileReadAuthority,
  source: FileReadAuthority | undefined
): FileReadAuthority {
  return {
    externalSshTargetId: file.externalSshTargetId ?? source?.externalSshTargetId,
    terminalArtifactGrantId: file.terminalArtifactGrantId ?? source?.terminalArtifactGrantId,
    readOnly: file.readOnly === true || source?.readOnly === true ? true : undefined
  }
}

export function createMarkdownPreviewActions(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  | 'openNewMarkdownInActiveWorkspace'
  | 'openMarkdownPreview'
  | 'makePreviewFilePermanent'
  | 'pinFile'
> {
  return {
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
          operationContext.target,
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
      // Why: with the source tab closed, a retarget keeps the authority the preview already reads with.
      const { externalSshTargetId, terminalArtifactGrantId, readOnly } = inheritFileReadAuthority(
        file,
        initialState.openFiles.find((openFile) => openFile.id === sourceFileId) ??
          initialState.openFiles.find((openFile) => openFile.id === id)
      )
      const anchor = options?.anchor || undefined
      set((s) => {
        const existing = s.openFiles.find((openFile) => openFile.id === id)
        const worktreeId = file.worktreeId
        const runtimeEnvironmentId = resolvedRuntimeEnvironmentId
        const activeResult = buildEditorActiveResult(s, worktreeId, id)

        if (existing) {
          // Why: a fresh grant means the file was re-resolved; cached bytes may predate it.
          const grantChanged =
            terminalArtifactGrantId !== undefined &&
            existing.terminalArtifactGrantId !== terminalArtifactGrantId
          const needsUpdate =
            existing.relativePath !== file.relativePath ||
            existing.filePath !== file.filePath ||
            existing.language !== file.language ||
            existing.externalSshTargetId !== externalSshTargetId ||
            existing.terminalArtifactGrantId !== terminalArtifactGrantId ||
            existing.readOnly !== readOnly ||
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
                        terminalArtifactGrantId,
                        readOnly,
                        ...(grantChanged
                          ? { fileContentReloadNonce: (openFile.fileContentReloadNonce ?? 0) + 1 }
                          : {}),
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
          terminalArtifactGrantId,
          readOnly,
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
      const promoted: Tab[] = []
      set((s) => {
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          promoted.push(...previewEditorTabsOf(s.unifiedTabsByWorktree, fileId, tabId))
        }
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
            return withPreviewEnded(tab)
          })
        }
        return changed ? { openFiles, unifiedTabsByWorktree } : s
      })
      // Switch point: main records the preview tabs the user made permanent.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && promoted.length > 0) {
        recordPromotedEditorTabsInLayoutOwner(get(), promoted)
      }
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
