import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  editorViewPlacement,
  editorViewTab
} from '@/store/slices/editor/tabs/editor-view-placement'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { captureBrowserLinkReveal } from '@/lib/browser/navigation/browser-link-reveal'
import { beginLinkOpenRequest } from '@/lib/link-open-request'
import { captureLinkOpenIntent } from '@/lib/link-open-intent'
import { flushEditorFrames } from './save/flush/editor-pending-flush'

export async function openEditorHtmlPreview(
  fileId: string,
  viewStateId: string | null
): Promise<void> {
  const initial = useAppStore.getState()
  const file = initial.openFiles.find((candidate) => candidate.id === fileId)
  const source = file && editorViewTab(initial, file.id, viewStateId)
  if (
    !file ||
    !source ||
    initial.activeWorktreeId !== source.worktreeId ||
    initial.groupsByWorktree[source.worktreeId]?.find((group) => group.id === source.groupId)
      ?.activeTabId !== source.id
  ) {
    return
  }
  initial.focusGroup(source.worktreeId, source.groupId)
  const isCurrentRequest = beginLinkOpenRequest()
  const reveal = captureBrowserLinkReveal(useAppStore.getState, useAppStore.subscribe, () => {
    const state = useAppStore.getState()
    const tab = state.unifiedTabsByWorktree[source.worktreeId]?.find(
      (candidate) => candidate.id === source.id
    )
    const groupId = state.activeGroupIdByWorktree[source.worktreeId]
    return (
      tab?.entityId === file.id &&
      tab.contentType === source.contentType &&
      tab.executionHostId === source.executionHostId &&
      groupId === tab.groupId &&
      state.groupsByWorktree[source.worktreeId]?.find((group) => group.id === tab.groupId)
        ?.activeTabId === source.id
    )
  })
  try {
    if (
      !(await flushEditorFrames(initial, file.id)) ||
      !isCurrentRequest() ||
      !reveal.canReveal()
    ) {
      return
    }
    const state = useAppStore.getState()
    const currentFile = state.openFiles.find((candidate) => candidate.id === file.id)
    if (!currentFile || currentFile.worktreeId !== file.worktreeId) {
      return
    }
    const placement = editorViewPlacement(state, currentFile, source.id)
    await new Promise<void>((resolve) => {
      const plan = openFileInBrowserTab({
        filePath: currentFile.filePath,
        worktreeId: currentFile.worktreeId,
        fileExecutionHostId: editorViewPlacement(initial, file, source.id).executionHostId,
        placementWorkspaceId: placement.placementWorkspaceId,
        linkContext: {
          linkIntent: captureLinkOpenIntent(state, placement.placementWorkspaceId, source.id, {
            explicitSourceGroup: true
          }),
          isCurrentRequest,
          canReveal: reveal.canReveal
        },
        onLinkOutcome: () => resolve()
      })
      if (plan.status === 'unsupported') {
        toast.error(plan.message)
      }
    })
  } finally {
    reveal.dispose()
  }
}
