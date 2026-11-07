import { editorViewTab } from '@/store/slices/editor/tabs/editor-view-placement'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { captureBrowserLinkReveal } from '@/lib/browser/navigation/browser-link-reveal'
import { beginLinkOpenRequest } from '@/lib/link-open-request'
import { isLiveLinkOpenGroup } from '@/lib/link-open-intent'
import { runAfterEditorFramesFlush } from './save/flush/editor-pending-flush'

export function openEditorHtmlPreview(fileId: string, viewStateId: string | null): void {
  const initial = useAppStore.getState()
  const file = initial.openFiles.find((candidate) => candidate.id === fileId)
  if (!file) {
    return
  }
  const source = editorViewTab(initial, file.id, viewStateId)
  const placementWorkspaceId = source?.worktreeId ?? file.worktreeId
  if (!source || initial.activeWorktreeId !== placementWorkspaceId) {
    return
  }
  const isCurrentRequest = beginLinkOpenRequest()
  const reveal = captureBrowserLinkReveal(useAppStore.getState, useAppStore.subscribe)
  let activeGroupId = initial.activeGroupIdByWorktree[placementWorkspaceId]
  let sourceGroupId: string | undefined = source.groupId
  let ownsSelection = true
  const unsubscribe = useAppStore.subscribe((state) => {
    const groupId = state.activeGroupIdByWorktree[placementWorkspaceId]
    const tabGroupId = state.unifiedTabsByWorktree[placementWorkspaceId]?.find(
      (tab) => tab.id === source.id
    )?.groupId
    ownsSelection &&=
      (groupId === activeGroupId || (tabGroupId !== sourceGroupId && groupId === tabGroupId)) &&
      state.groupsByWorktree[placementWorkspaceId]?.find((group) => group.id === tabGroupId)
        ?.activeTabId === source.id
    activeGroupId = groupId
    sourceGroupId = tabGroupId
  })
  runAfterEditorFramesFlush(initial, [file.id], (_deferred, flushed) => {
    try {
      if (!flushed) {
        return
      }
      const state = useAppStore.getState()
      const currentFile = state.openFiles.find((candidate) => candidate.id === file.id)
      const tab = state.unifiedTabsByWorktree[placementWorkspaceId]?.find(
        (candidate) => candidate.id === source.id
      )
      if (
        !ownsSelection ||
        !isCurrentRequest() ||
        !reveal.canReveal() ||
        !currentFile ||
        currentFile.worktreeId !== file.worktreeId ||
        !tab ||
        tab.entityId !== currentFile.id ||
        tab.contentType !== source.contentType ||
        tab.executionHostId !== source.executionHostId ||
        !isLiveLinkOpenGroup(state, placementWorkspaceId, tab.groupId) ||
        state.groupsByWorktree[placementWorkspaceId]?.find((group) => group.id === tab.groupId)
          ?.activeTabId !== tab.id
      ) {
        return
      }
      const plan = openFileInBrowserTab({
        filePath: currentFile.filePath,
        worktreeId: file.worktreeId,
        placementWorkspaceId,
        targetGroupId: tab.groupId
      })
      if (plan.status === 'unsupported') {
        toast.error(plan.message)
      }
    } finally {
      unsubscribe()
      reveal.dispose()
    }
  })
}
