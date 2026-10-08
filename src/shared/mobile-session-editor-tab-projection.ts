import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from './runtime-mobile-session-tab-contracts'

// Why shared: a desktop window and a host with no window both publish editor tabs to phones, and
// a phone must not see two shapes for one file depending on which side owned it.

export type MobileSessionEditorFileFacts = {
  id: string
  filePath: string
  relativePath: string
  language: string
  mode: string
  isDirty: boolean
  diffSource?: string
}

export type MobileSessionEditorTabPresentation = {
  /** Unified tab wrapper id when one exists, else the file id. */
  tabId: string
  isActive: boolean
  color?: string | null
  isPinned?: boolean
}

export function isMobileSessionMarkdownEditorFile(
  file: Pick<MobileSessionEditorFileFacts, 'mode' | 'language'>
): boolean {
  if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
    return false
  }
  return file.language === 'markdown' || file.mode === 'markdown-preview'
}

export function isMobileSessionFileDiffSource(
  diffSource: string | undefined
): diffSource is 'staged' | 'unstaged' {
  return diffSource === 'staged' || diffSource === 'unstaged'
}

function editorTabTitle(relativePath: string, fallback: string): string {
  return relativePath.split(/[\\/]/).pop() || relativePath || fallback
}

export function projectMobileSessionMarkdownTab(
  presentation: MobileSessionEditorTabPresentation,
  file: MobileSessionEditorFileFacts,
  sourceFile: MobileSessionEditorFileFacts,
  /** A desktop draft version; absent means the file on disk is the document. */
  draftVersion?: string
): RuntimeMobileSessionMarkdownTab | null {
  if (!isMobileSessionMarkdownEditorFile(file)) {
    return null
  }
  return {
    type: 'markdown',
    id: presentation.tabId,
    title: editorTabTitle(file.relativePath, 'Markdown'),
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: 'markdown',
    mode: file.mode === 'markdown-preview' ? 'markdown-preview' : 'edit',
    isDirty: file.isDirty || sourceFile.isDirty,
    isActive: presentation.isActive,
    sourceFileId: sourceFile.id,
    sourceFilePath: sourceFile.filePath,
    sourceRelativePath: sourceFile.relativePath,
    documentVersion: draftVersion ?? `file:${sourceFile.id}`,
    color: presentation.color ?? null,
    isPinned: presentation.isPinned === true
  }
}

export function projectMobileSessionFileTab(
  presentation: MobileSessionEditorTabPresentation,
  file: MobileSessionEditorFileFacts
): RuntimeMobileSessionFileTab {
  const diffSource = isMobileSessionFileDiffSource(file.diffSource) ? file.diffSource : undefined
  return {
    type: 'file',
    id: presentation.tabId,
    title: editorTabTitle(file.relativePath, 'File'),
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    mode: file.mode === 'diff' ? 'diff' : 'edit',
    ...(diffSource ? { diffSource } : {}),
    isDirty: file.isDirty,
    color: presentation.color ?? null,
    isPinned: presentation.isPinned === true,
    isActive: presentation.isActive
  }
}
