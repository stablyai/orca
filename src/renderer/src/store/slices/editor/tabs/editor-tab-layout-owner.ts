// What editor tabs send main in a layout-owner build: opens, closes, promotions, moves and renames
// go to main first (editor-tab-*-through-layout-owner, restored-editor-move-through-layout-owner).

import type { Tab } from '../../../../../../shared/tab-types'
import type { LayoutEditorFile } from '../../../../../../shared/workspace-layout/workspace-layout-model'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from './editor-tab-content-type'

/** The preview tabs that show a file, which making the file permanent promotes. */
export function previewEditorTabsOf(
  tabsByWorktree: AppState['unifiedTabsByWorktree'],
  fileId: string,
  tabId?: string
): Tab[] {
  return Object.values(tabsByWorktree).flatMap((tabs) =>
    tabs.filter(
      (tab) =>
        tab.entityId === fileId &&
        tab.isPreview === true &&
        isEditorTabContentType(tab.contentType) &&
        (!tabId || tab.id === tabId)
    )
  )
}

/** The fields the window's session save keeps for an edit-mode file. */
export function restorableEditorFile(file: OpenFile): LayoutEditorFile {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    ...(file.runtimeEnvironmentId !== undefined
      ? { runtimeEnvironmentId: file.runtimeEnvironmentId }
      : {}),
    ...(file.externalSshTargetId ? { externalSshTargetId: file.externalSshTargetId } : {}),
    ...(file.readOnly === true ? { readOnly: true } : {}),
    ...(file.readOnly === true && file.liveTail === true ? { liveTail: true } : {})
  }
}
