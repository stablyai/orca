import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { basename } from '@/lib/path'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import { getConnectionIdForFile } from '@/lib/workspace/ownership/connection-context'
import { getRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { flushPendingEditorBuffer } from '../save/flush/editor-pending-flush'

const pendingSaves = new Map<string, Promise<boolean>>()

async function saveDraft(file: OpenFile, fallbackContent: string): Promise<boolean> {
  flushPendingEditorBuffer(useAppStore.getState(), file.id)
  const before = useAppStore.getState()
  const content = before.editorDrafts[file.id] ?? fallbackContent
  const activeWorkspace = before.activeWorktreeId
    ? before.getKnownWorktreeById(before.activeWorktreeId)
    : undefined
  const workspace =
    activeWorkspace?.repoId === file.projectDraftProjectId
      ? activeWorkspace
      : before.getKnownWorktreeById(file.worktreeId)
  const placementWorkspaceId = workspace?.id
  const defaultDirectory =
    workspace &&
    placementWorkspaceId &&
    getConnectionIdForFile(placementWorkspaceId, workspace.path) === null &&
    getRuntimeTargetForFileOwner(before, placementWorkspaceId, undefined)?.kind === 'local'
      ? workspace.path
      : undefined
  try {
    const result = await window.api.fs.saveDownloadedFile({
      suggestedName: file.relativePath,
      defaultDirectory,
      content,
      encoding: 'utf8'
    })
    if (result.canceled) {
      return false
    }
    flushPendingEditorBuffer(useAppStore.getState(), file.id)
    const state = useAppStore.getState()
    if ((state.editorDrafts[file.id] ?? fallbackContent) !== content) {
      toast.message(
        translate(
          'components.projectTextDraft.savedSnapshot',
          'Saved {{name}}. Newer edits remain in the draft.',
          { name: basename(result.destinationPath) }
        )
      )
      return false
    }
    if (!defaultDirectory) {
      toast.message(
        translate(
          'components.projectTextDraft.savedLocalCopy',
          'Saved a local copy as {{name}}. This project draft is kept.',
          { name: basename(result.destinationPath) }
        )
      )
      return true
    }
    if (
      state.openFiles.some(
        (candidate) => candidate.filePath === result.destinationPath && candidate.isDirty
      )
    ) {
      toast.message(
        translate(
          'components.projectTextDraft.otherUnsavedTab',
          'The file was saved. Resolve its other unsaved tab before closing this draft.'
        )
      )
      return false
    }
    const live = state.openFiles.find((candidate) => candidate.id === file.id)
    if (!live) {
      return true
    }
    state.markFileDirty(file.id, false)
    state.clearEditorDraft(file.id)
    const fileIds = new Set([file.id, ...editorBufferSiblingViewIds(state, file.id)])
    const tabIds = Object.values(state.unifiedTabsByWorktree)
      .flat()
      .filter((tab) => fileIds.has(tab.entityId))
      .map((tab) => tab.id)
    state.closeUnifiedTabs(tabIds)
    for (const fileId of fileIds) {
      useAppStore.getState().closeFile(fileId, { captureRecentlyClosed: false })
    }
    state.openFile(
      {
        filePath: result.destinationPath,
        relativePath: result.destinationPath,
        worktreeId: placementWorkspaceId ?? FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: detectLanguage(result.destinationPath),
        mode: 'edit'
      },
      {
        preview: false,
        focusEditor: true,
        suppressActiveRuntimeFallback: true
      }
    )
    if (placementWorkspaceId && useAppStore.getState().activeWorktreeId === null) {
      useAppStore.getState().setActiveWorktree(placementWorkspaceId)
    }
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate('components.projectTextDraft.saveFailed', 'Could not save the file.')
    )
    return false
  }
}

export function saveProjectTextDraft(file: OpenFile, content: string): Promise<boolean> {
  const pending = pendingSaves.get(file.filePath)
  if (pending) {
    return pending
  }
  const request = saveDraft(file, content).finally(() => pendingSaves.delete(file.filePath))
  pendingSaves.set(file.filePath, request)
  return request
}
