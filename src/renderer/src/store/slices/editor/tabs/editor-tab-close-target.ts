import type { OpenFile } from '../types/open-file'
import type { AppState } from '../../../types'
import type { Tab } from '../../../../../../shared/tab-types'
import { editorBufferIdOfView, editorBufferSiblingViewIds } from '../buffers/editor-buffer-views'
import { needsSavePromptOnClose } from '../buffers/editor-buffer-close-rule'
import {
  editorContentIsReferenced,
  editorPlacementIndex,
  openFileIndex
} from './workspace-editor-files'
import { isEditorTabContentType } from './editor-tab-content-type'
import { hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'

export function editorCloseTarget(state: AppState, id: string) {
  const candidate = editorPlacementIndex(state.unifiedTabsByWorktree).tabById.get(id)
  const tab = candidate && isEditorTabContentType(candidate.contentType) ? candidate : undefined
  const file = openFileIndex(state.openFiles).get(tab?.entityId ?? id)
  return { file, tab }
}

export function editorTabNeedsSavePrompt(state: AppState, tab: Tab): boolean {
  return (
    !editorContentIsReferenced(state, tab.entityId, tab.id) &&
    needsSavePromptOnClose(state, tab.entityId)
  )
}

/** Reserve one final placement when the batch removes a dirty buffer's last editable views. */
export function editorTabsNeedingSavePrompt(state: AppState, tabs: readonly Tab[]): Set<string> {
  const selected = new Set(tabs.map((tab) => tab.id))
  const lastByBuffer = new Map(tabs.map((tab) => [editorBufferIdOfView(state, tab.entityId), tab]))
  const references = editorPlacementIndex(state.unifiedTabsByWorktree).tabIdsByEntityId
  const prompts = new Set<string>()
  const files = openFileIndex(state.openFiles)
  for (const tab of lastByBuffer.values()) {
    const siblings = editorBufferSiblingViewIds(state, tab.entityId)
    if (
      siblings.some((id) => files.get(id)?.isDirty) &&
      siblings.every(
        (fileId) =>
          !hasPendingEntityTab(null, fileId) &&
          [...(references.get(fileId) ?? [])].every((id) => selected.has(id))
      )
    ) {
      prompts.add(tab.id)
    }
  }
  return prompts
}

export function findAdjacentOpenFileId(
  files: readonly OpenFile[],
  closedFileIds: ReadonlySet<string>,
  preferredFileId: string | null
): string | null {
  const preferredIndex = files.findIndex((file) => file.id === preferredFileId)
  const nextFile = files
    .slice(Math.max(preferredIndex + 1, 0))
    .find((file) => !closedFileIds.has(file.id))
  if (nextFile) {
    return nextFile.id
  }
  return (
    files
      .slice(0, Math.max(preferredIndex, 0))
      .toReversed()
      .find((file) => !closedFileIds.has(file.id))?.id ?? null
  )
}
