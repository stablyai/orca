import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { requestEditorFileClose } from '../editor/editor-autosave'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { closeWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-close'

export function createWorkspaceTabCloseCommands({
  worktreeId,
  groupTabs
}: {
  worktreeId: string
  groupTabs: Tab[]
}) {
  const { closeUnifiedTab, closeFile } = useAppStore.getState()

  const closeEditorIfUnreferenced = (
    entityId: string,
    closingTabId: string,
    whenEmptied: (() => void) | null
  ) => {
    const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
      (item) =>
        item.id !== closingTabId &&
        item.entityId === entityId &&
        (item.contentType === 'editor' ||
          item.contentType === 'diff' ||
          item.contentType === 'conflict-review' ||
          item.contentType === 'check-details')
    )
    if (!otherReference) {
      const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === entityId)
      if (file?.isDirty) {
        // Why: route through Terminal.tsx so the unsaved-confirmation save/discard queue stays centralized across all close paths.
        requestEditorFileClose(entityId, whenEmptied ? { onClosed: whenEmptied } : undefined)
        return false
      }
      closeFile(entityId)
    }
    return true
  }

  /** `whenEmptied` is captured by the caller when the close is requested, before any prompt. */
  const closeItem = (
    itemId: string,
    opts?: { whenEmptied?: () => void; skipRunningProcessConfirm?: boolean }
  ) => {
    const item = groupTabs.find((candidate) => candidate.id === itemId)
    if (!item) {
      return
    }
    const whenEmptied = opts?.whenEmptied ?? null
    if (item.contentType === 'agent-session') {
      closeUnifiedTab(item.id)
      whenEmptied?.()
      return
    }
    if (item.contentType === 'terminal') {
      // Why: closeTerminalTab can defer behind a pin / running-process dialog, so the
      // empty check has to run on the actual close — never on cancel.
      closeTerminalTab(item.entityId, {
        ...(opts?.skipRunningProcessConfirm ? { skipRunningProcessConfirm: true } : {}),
        ...(whenEmptied ? { onClosed: whenEmptied } : {})
      })
      return
    }
    if (item.contentType === 'browser') {
      const plan = closeWorkspaceBrowserTab(worktreeId, item.entityId, item.id)
      // Why: the empty check below answers "the user emptied this worktree". Unwinding a create
      // that never finished is not that — it must leave the selection as the click found it.
      if (!plan.closesLocally || plan.localCloseReason === 'cleanup') {
        return
      }
    } else if (item.contentType === 'simulator') {
      closeUnifiedTab(item.id)
    } else {
      const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id, whenEmptied)
      if (!canCloseTab) {
        return
      }
      closeUnifiedTab(item.id)
    }
    whenEmptied?.()
  }

  return { closeItem }
}
