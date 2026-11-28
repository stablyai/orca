import { useAppStore } from '@/store/index'
import { sideGroupPlacement } from '@/lib/browser/documents/side-group-placement'

/** Rendered Markdown beside its diff, in the same side group an HTML preview would use. */
export function openMarkdownPreviewToSide(params: {
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
  sourceGroupId: string | null
  placementWorkspaceId?: string
}): void {
  const state = useAppStore.getState()
  const worktreeId = params.placementWorkspaceId ?? params.worktreeId
  const side = sideGroupPlacement(state, worktreeId, params.sourceGroupId)
  if (!side) {
    return
  }
  const targetGroupId =
    side.existingSibling ??
    state.createEmptySplitGroup(worktreeId, side.sourceGroupId, 'right', { activate: false })
  if (!targetGroupId) {
    return
  }
  state.openMarkdownPreview(
    {
      filePath: params.filePath,
      relativePath: params.relativePath,
      worktreeId: params.worktreeId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      language: 'markdown'
    },
    { targetGroupId, placementWorkspaceId: worktreeId }
  )
}
