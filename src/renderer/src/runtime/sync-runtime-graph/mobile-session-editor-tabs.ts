import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { editorRowHost } from '../../../../shared/session-tab-file-host'
import type { MobileSessionWorktreeInputs } from './types'
import {
  getMobileMarkdownSourceFile,
  isFileActiveEditorSurface,
  isMobileFileDiffSource,
  isUnifiedTabActiveInActiveGroup
} from './mobile-session-surfaces'

export function buildMobileMarkdownTab(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab?: Tab
): RuntimeMobileSessionMarkdownTab | null {
  const sourceFile = getMobileMarkdownSourceFile(file, inputs.openFilesById)
  if (!sourceFile) {
    return null
  }
  const draftVersion = inputs.editorDraftVersionByFileId.get(sourceFile.id)
  const title = file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'Markdown'
  const unifiedTabId = unifiedTab?.id
  return {
    type: 'markdown',
    id: unifiedTabId ?? file.id,
    title,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: 'markdown',
    mode: file.mode === 'markdown-preview' ? 'markdown-preview' : 'edit',
    isDirty: file.isDirty || sourceFile.isDirty,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : isFileActiveEditorSurface(inputs, file),
    sourceFileId: sourceFile.id,
    sourceFilePath: sourceFile.filePath,
    sourceRelativePath: sourceFile.relativePath,
    ...(sourceFile.isUntitled ? { isUntitled: true as const } : {}),
    documentVersion: draftVersion ?? `file:${sourceFile.id}`,
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true,
    ...editorRowHost(file)
  }
}

export function buildMobileFileTab(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab?: Tab
): RuntimeMobileSessionFileTab {
  const title = file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'File'
  const diffSource = isMobileFileDiffSource(file.diffSource) ? file.diffSource : undefined
  const unifiedTabId = unifiedTab?.id
  return {
    type: 'file',
    id: unifiedTabId ?? file.id,
    title,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    mode: file.mode === 'diff' ? 'diff' : 'edit',
    ...(diffSource ? { diffSource } : {}),
    isDirty: file.isDirty,
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : isFileActiveEditorSurface(inputs, file),
    ...editorRowHost(file)
  }
}
