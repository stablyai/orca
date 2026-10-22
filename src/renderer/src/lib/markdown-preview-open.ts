import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findSiblingGroupId } from '@/store/slices/tabs'
import { isLiveEditorOpenGroup } from '@/store/slices/editor/tabs/editor-open-target-group'
import { detectLanguage } from './language-detect'

export function openMarkdownPreviewToSide(
  file: Parameters<AppState['openMarkdownPreview']>[0],
  options: { sourceGroupId?: string | null; sourceFileId?: string } = {}
): boolean {
  if (detectLanguage(file.filePath) !== 'markdown') {
    return false
  }
  const state = useAppStore.getState()
  const worktreeId = file.worktreeId
  const sourceGroupId =
    options.sourceGroupId ??
    state.activeGroupIdByWorktree[worktreeId] ??
    state.groupsByWorktree[worktreeId]?.[0]?.id
  if (!sourceGroupId) {
    state.openMarkdownPreview(file, { sourceFileId: options.sourceFileId })
    return true
  }
  if (!isLiveEditorOpenGroup(state, worktreeId, sourceGroupId)) {
    return false
  }
  const layout = state.layoutByWorktree[worktreeId]
  const sibling = layout ? findSiblingGroupId(layout, sourceGroupId) : null
  const targetGroupId =
    sibling ?? state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right', { activate: false })
  if (!targetGroupId) {
    return false
  }
  useAppStore
    .getState()
    .openMarkdownPreview(file, { sourceFileId: options.sourceFileId, targetGroupId })
  return true
}
