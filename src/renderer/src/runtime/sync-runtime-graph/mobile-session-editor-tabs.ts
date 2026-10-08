import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import {
  isMobileSessionMarkdownEditorFile,
  projectMobileSessionFileTab,
  projectMobileSessionMarkdownTab,
  type MobileSessionEditorTabPresentation
} from '../../../../shared/mobile-session-editor-tab-projection'
import type { MobileSessionWorktreeInputs } from './types'
import {
  isFileActiveEditorSurface,
  isUnifiedTabActiveInActiveGroup
} from './mobile-session-surfaces'

function editorTabPresentation(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab: Tab | undefined
): MobileSessionEditorTabPresentation {
  const unifiedTabId = unifiedTab?.id
  return {
    tabId: unifiedTabId ?? file.id,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : isFileActiveEditorSurface(inputs, file),
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true
  }
}

export function buildMobileMarkdownTab(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab?: Tab
): RuntimeMobileSessionMarkdownTab | null {
  if (!isMobileSessionMarkdownEditorFile(file)) {
    return null
  }
  const sourceFile =
    file.mode === 'markdown-preview' && file.markdownPreviewSourceFileId
      ? (inputs.openFilesById?.get(file.markdownPreviewSourceFileId) ?? file)
      : file
  return projectMobileSessionMarkdownTab(
    editorTabPresentation(inputs, file, unifiedTab),
    file,
    sourceFile,
    inputs.editorDraftVersionByFileId.get(sourceFile.id)
  )
}

export function buildMobileFileTab(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab?: Tab
): RuntimeMobileSessionFileTab {
  return projectMobileSessionFileTab(editorTabPresentation(inputs, file, unifiedTab), file)
}
