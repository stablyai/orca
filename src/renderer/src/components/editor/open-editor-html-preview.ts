import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  editorViewPlacement,
  editorViewTab
} from '@/store/slices/editor/tabs/editor-view-placement'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { resolveFileBrowserLinkExecutionHostId } from '@/lib/file-preview-link-open'
import { captureBrowserLinkReveal } from '@/lib/browser/navigation/browser-link-reveal'
import { createBrowserLinkHostMatcher } from '@/lib/browser/navigation/browser-link-owner'
import { beginLinkOpenRequest, subscribeLinkOpenRequests } from '@/lib/link-open-request'
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
  const fileExecutionHostId =
    editorViewPlacement(initial, file, source.id).executionHostId ??
    resolveFileBrowserLinkExecutionHostId(initial, file.worktreeId)
  if (!fileExecutionHostId) {
    return
  }
  initial.focusGroup(source.worktreeId, source.groupId)
  const isCurrentRequest = beginLinkOpenRequest()
  let checkedState: typeof initial | null = null
  let sourceIsSelected = false
  const reveal = captureBrowserLinkReveal(useAppStore.getState, useAppStore.subscribe, () => {
    if (!isCurrentRequest()) {
      return false
    }
    const state = useAppStore.getState()
    const tabs = state.unifiedTabsByWorktree[source.worktreeId]
    const groups = state.groupsByWorktree[source.worktreeId]
    const groupId = state.activeGroupIdByWorktree[source.worktreeId]
    if (
      checkedState &&
      tabs === checkedState.unifiedTabsByWorktree[source.worktreeId] &&
      groups === checkedState.groupsByWorktree[source.worktreeId] &&
      groupId === checkedState.activeGroupIdByWorktree[source.worktreeId]
    ) {
      return sourceIsSelected
    }
    checkedState = state
    const tab = tabs?.find((candidate) => candidate.id === source.id)
    sourceIsSelected =
      tab?.entityId === file.id &&
      tab.contentType === source.contentType &&
      tab.executionHostId === source.executionHostId &&
      groupId === tab.groupId &&
      groups?.find((group) => group.id === tab.groupId)?.activeTabId === source.id
    return sourceIsSelected
  })
  const unsubscribeRequests = subscribeLinkOpenRequests(() => {
    reveal.dispose()
    unsubscribeRequests()
  })
  try {
    if (
      !reveal.canReveal() ||
      !(await flushEditorFrames(initial, file.id)) ||
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
    if (
      !createBrowserLinkHostMatcher(
        state,
        currentFile.worktreeId,
        fileExecutionHostId
      )(placement.executionHostId)
    ) {
      return
    }
    await new Promise<void>((resolve) => {
      const plan = openFileInBrowserTab({
        filePath: currentFile.filePath,
        worktreeId: currentFile.worktreeId,
        fileExecutionHostId,
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
    unsubscribeRequests()
  }
}
