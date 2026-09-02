import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import type { MobileSessionWorktreeInputs } from './types'
import {
  isFileActiveEditorSurface,
  isMobileFileDiffSource,
  isUnifiedTabActiveInActiveGroup
} from './mobile-session-surfaces'

export function buildMobileMarkdownTab(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab?: Tab
): RuntimeMobileSessionMarkdownTab | null {
  if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
    return null
  }
  if (file.language !== 'markdown' && file.mode !== 'markdown-preview') {
    return null
  }
  const sourceFile =
    file.mode === 'markdown-preview' && file.markdownPreviewSourceFileId
      ? (inputs.openFilesById?.get(file.markdownPreviewSourceFileId) ?? file)
      : file
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
    mode: file.mode,
    isDirty: file.isDirty || sourceFile.isDirty,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : isFileActiveEditorSurface(inputs, file),
    sourceFileId: sourceFile.id,
    sourceFilePath: sourceFile.filePath,
    sourceRelativePath: sourceFile.relativePath,
    documentVersion: draftVersion ?? `file:${sourceFile.id}`,
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true
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
      : isFileActiveEditorSurface(inputs, file)
  }
}
