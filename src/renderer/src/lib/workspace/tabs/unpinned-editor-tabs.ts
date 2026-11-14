import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { saveEditorFileNow } from '@/components/editor/autosave/editor-save-now'
import { editorTabNeedsSavePrompt } from '@/store/slices/editor/tabs/editor-tab-close-target'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { dispatchWorkspaceTabCommand } from './workspace-tab-commands'

function unpinnedEditorTabIds(worktreeId: string): string[] {
  const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
  return tabs
    .filter((tab) => isEditorTabContentType(tab.contentType) && !tab.isPinned)
    .map((tab) => tab.id)
}

/** Closes clean unpinned editor tabs; a tab that needs a save prompt stays open. */
export function closeUnpinnedEditorTabs(worktreeId: string): void {
  for (const tabId of unpinnedEditorTabIds(worktreeId)) {
    // Re-read per tab: closing one view changes which buffer references remain.
    const state = useAppStore.getState()
    const tab = state.unifiedTabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
    if (!tab || editorTabNeedsSavePrompt(state, tab)) {
      continue
    }
    dispatchWorkspaceTabCommand({
      type: 'close',
      bulk: true,
      target: { kind: 'tab', worktreeId, tabId }
    })
  }
}

/** Saves each dirty unpinned editor file in turn, then closes the unpinned tabs that are now clean. */
export async function saveAndCloseUnpinnedEditorTabs(worktreeId: string): Promise<void> {
  const attemptedFileIds = new Set<string>()
  const failedFiles: string[] = []
  for (const tabId of unpinnedEditorTabIds(worktreeId)) {
    const state = useAppStore.getState()
    const tab = state.unifiedTabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
    const file = tab ? state.openFiles.find((openFile) => openFile.id === tab.entityId) : undefined
    if (!file?.isDirty || attemptedFileIds.has(file.id)) {
      continue
    }
    attemptedFileIds.add(file.id)
    // Why: an untitled buffer has no real path yet; Ctrl+S asks for a name, so this leaves it open.
    const result = file.isUntitled
      ? 'failed'
      : await saveEditorFileNow(file).catch(() => 'failed' as const)
    if (result !== 'written') {
      failedFiles.push(file.relativePath)
    }
  }
  closeUnpinnedEditorTabs(worktreeId)
  if (failedFiles.length > 0) {
    toast.error(
      translate(
        'tabs.saveAndCloseUnpinned.failed',
        "Couldn't save {{files}}. Their tabs stayed open.",
        { files: failedFiles.join(', ') }
      )
    )
  }
}
