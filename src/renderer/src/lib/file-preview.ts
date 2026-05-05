import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { useAppStore } from '@/store'
import { findSiblingGroupId } from '@/store/slices/tabs'

export type PreviewableLanguage = 'html'

export function canPreviewLanguage(language: string): language is PreviewableLanguage {
  return language === 'html'
}

// Why: "Open Preview to the Side" mirrors the VS Code pattern — the rendered
// view goes into the group to the right of the editor, creating a right split
// if one doesn't already exist. Keeps the editor source visible alongside the
// preview instead of replacing the active tab.
export function openFilePreviewToSide(params: {
  language: string
  filePath: string
  worktreeId: string
  sourceGroupId: string | null
}): void {
  if (!canPreviewLanguage(params.language)) {
    return
  }

  const state = useAppStore.getState()
  const worktreeId = params.worktreeId

  // Resolve the group this action originated from. Prefer the caller-supplied
  // id (the tab's own group under split-pane layouts), fall back to the
  // worktree's active group.
  const sourceGroupId =
    params.sourceGroupId ??
    state.activeGroupIdByWorktree[worktreeId] ??
    state.groupsByWorktree[worktreeId]?.[0]?.id ??
    null
  if (!sourceGroupId) {
    return
  }

  const layout = state.layoutByWorktree[worktreeId] ?? null
  const existingSibling = layout ? findSiblingGroupId(layout, sourceGroupId) : null

  let targetGroupId = existingSibling
  if (!targetGroupId) {
    // Why: no split yet — create one to the right so the preview lands beside
    // the editor. createEmptySplitGroup returns the new (empty) group id.
    targetGroupId = state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right')
  }
  if (!targetGroupId) {
    return
  }

  const fileUrl = absolutePathToFileUri(params.filePath)
  const title = params.filePath.split(/[/\\]/).pop() ?? params.filePath

  state.createBrowserTab(worktreeId, fileUrl, {
    title,
    targetGroupId,
    activate: true
  })
}
