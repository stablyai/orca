import { detectLanguage } from '@/lib/language-detect'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { isSameEditorOwner } from '@/store/slices/editor/file-ids/editor-file-ids'
import { readRuntimeDirectory } from '@/runtime/runtime-file-client'
import { sortDirEntries } from '../../../../shared/file-name-sort'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { shouldIncludeFileExplorerEntry } from '../right-sidebar/file-explorer-entries'
import { getEditorHeaderPathOpenKind } from './editor-header-path-segments'

export type EditorHeaderDirectoryListing =
  | { status: 'ok'; entries: DirEntry[] }
  | { status: 'error'; message: string }

type EditorHeaderPathOwnerFile = Pick<
  OpenFile,
  'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId' | 'operationProvenance'
>

export async function listEditorHeaderDirectory(
  file: EditorHeaderPathOwnerFile,
  worktreePath: string | null,
  directoryAbsolutePath: string
): Promise<EditorHeaderDirectoryListing> {
  try {
    const context = getEditorFileOperationContext(useAppStore.getState(), file, worktreePath)
    const entries = await readRuntimeDirectory(context, directoryAbsolutePath)
    return {
      status: 'ok',
      entries: sortDirEntries(entries.filter(shouldIncludeFileExplorerEntry))
    }
  } catch (error) {
    return {
      status: 'error',
      message: extractIpcErrorMessage(
        error,
        translate(
          'auto.components.editor.EditorPanelHeaderPath.7e2c1a9b04',
          'Could not list this folder.'
        )
      )
    }
  }
}

export function joinEditorHeaderPathEntry(
  directoryAbsolutePath: string,
  directoryRelativePath: string,
  entryName: string
): { filePath: string; relativePath: string } {
  return {
    filePath: joinPath(directoryAbsolutePath, entryName),
    relativePath: normalizeRelativePath(
      directoryRelativePath ? `${directoryRelativePath}/${entryName}` : entryName
    )
  }
}

export function openEditorHeaderPathFile(args: {
  currentFile: Pick<
    OpenFile,
    'mode' | 'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId' | 'operationProvenance'
  >
  filePath: string
  relativePath: string
  targetGroupId?: string
  openFile: (file: Omit<OpenFile, 'id' | 'isDirty'>, options?: { targetGroupId?: string }) => string
  openMarkdownPreview: (
    file: Pick<
      OpenFile,
      | 'filePath'
      | 'relativePath'
      | 'worktreeId'
      | 'language'
      | 'runtimeEnvironmentId'
      | 'externalSshTargetId'
    >,
    options?: { targetGroupId?: string }
  ) => void
}): void {
  const language = detectLanguage(args.relativePath)
  const kind = getEditorHeaderPathOpenKind(args.currentFile.mode, language)
  const state = useAppStore.getState()
  const existingFile = state.openFiles.find(
    (file) =>
      file.filePath === args.filePath &&
      file.mode === kind &&
      isSameEditorOwner(file, args.currentFile.worktreeId, args.currentFile.runtimeEnvironmentId)
  )
  const existingTab = existingFile
    ? (state.unifiedTabsByWorktree[args.currentFile.worktreeId] ?? []).find(
        (tab) => tab.entityId === existingFile.id && tab.contentType === 'editor'
      )
    : undefined
  if (existingTab) {
    state.activateTab(existingTab.id)
  }
  const targetGroupId = existingTab?.groupId ?? args.targetGroupId
  if (kind === 'markdown-preview') {
    args.openMarkdownPreview(
      {
        filePath: args.filePath,
        relativePath: args.relativePath,
        worktreeId: args.currentFile.worktreeId,
        language,
        runtimeEnvironmentId: args.currentFile.runtimeEnvironmentId,
        externalSshTargetId: args.currentFile.externalSshTargetId
      },
      targetGroupId === undefined ? undefined : { targetGroupId }
    )
    return
  }

  args.openFile(
    {
      filePath: args.filePath,
      relativePath: args.relativePath,
      worktreeId: args.currentFile.worktreeId,
      language,
      mode: 'edit',
      runtimeEnvironmentId: args.currentFile.runtimeEnvironmentId,
      externalSshTargetId: args.currentFile.externalSshTargetId,
      operationProvenance: args.currentFile.operationProvenance
    },
    targetGroupId === undefined ? undefined : { targetGroupId }
  )
}
