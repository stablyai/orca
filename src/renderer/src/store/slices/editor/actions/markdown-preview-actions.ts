import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import { createUntitledFileInActiveWorkspace } from './untitled-file-creation'
import type { OpenFile } from '../types/open-file'
import { resolveEditorFileIdForOwner } from '../file-ids/editor-file-ids'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import type { Tab } from '../../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { withPreviewEnded } from '../../tabs/tab-preview-flag'
import { previewEditorTabsOf } from '../tabs/editor-tab-layout-owner'
import { afterPendingEntityTabs, hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'
import {
  endsPreviewHere,
  promotePreviewTabsThroughLayoutOwner
} from '../../tabs/preview-tab-promotion'

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
      const created = await createUntitledFileInActiveWorkspace(
        get,
        groupId,
        (context) =>
          createUntitledMarkdownFileWithTemplateSelection(
            context.worktreePath,
            context.worktreeId,
            context.connectionId,
            context.target,
            context.operationProvenance,
            context.expectedSshConnectionGeneration,
            context.expectedSshTargetId,
            context.expectedExecutionHostId,
            context.assertOperationCurrent
          ),
        'Failed to create untitled markdown file.'
      )
      if (created) {
        get().recordFeatureInteraction('markdown-file-created')
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
      const anchor = options?.anchor || undefined
      set((s) => {
        const existing = s.openFiles.find((openFile) => openFile.id === id)
        // Why: with the source tab closed, a retarget keeps the authority the preview already reads with.
        const { externalSshTargetId, terminalArtifactGrantId, readOnly } = inheritFileReadAuthority(
          file,
          s.openFiles.find((openFile) => openFile.id === sourceFileId) ??
            s.openFiles.find((openFile) => openFile.id === id)
        )
        const source = s.openFiles.find((openFile) => openFile.id === sourceFileId)
        const operationProvenance =
          file.externalSshTargetId !== undefined
            ? (file.operationProvenance ?? source?.operationProvenance)
            : (existing?.operationProvenance ??
              file.operationProvenance ??
              source?.operationProvenance)
        const worktreeId = file.worktreeId
        const runtimeEnvironmentId = resolvedRuntimeEnvironmentId
        const activeResult = buildEditorActiveResult(s, worktreeId, id)

        if (existing) {
          // Why: a fresh grant means the file was re-resolved; cached bytes may predate it.
          const grantChanged =
            terminalArtifactGrantId !== undefined &&
            existing.terminalArtifactGrantId !== terminalArtifactGrantId
          const needsUpdate =
            existing.operationProvenance !== operationProvenance ||
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
                        operationProvenance,
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
          operationProvenance,
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
            // Switch point: main's frame ends a preview main owns.
            if (!endsPreviewHere(s, worktreeId)) {
              return tab
            }
            changed = true
            return withPreviewEnded(tab)
          })
        }
        return changed ? { openFiles, unifiedTabsByWorktree } : s
      })
      // Switch point: main makes the preview tabs the user kept permanent.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && promoted.length > 0) {
        promotePreviewTabsThroughLayoutOwner(get(), set, promoted)
      }
      // Switch point: a double click keeps a preview main has yet to draw, once its frame does.
      const worktreeId = get().openFiles.find((file) => file.id === fileId)?.worktreeId
      if (ORCA_LAYOUT_OWNER_IS_MAIN && worktreeId && hasPendingEntityTab(worktreeId, fileId)) {
        // Tabs asked for above are not asked again, even after main answered (or refused) them.
        const asked = new Set(promoted.map((tab) => tab.id))
        afterPendingEntityTabs(worktreeId, fileId, () =>
          promotePreviewTabsThroughLayoutOwner(
            get(),
            set,
            previewEditorTabsOf(get().unifiedTabsByWorktree, fileId, tabId).filter(
              (tab) => !asked.has(tab.id)
            )
          )
        )
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
