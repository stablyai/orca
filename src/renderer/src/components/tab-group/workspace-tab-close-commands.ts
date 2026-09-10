import { toast } from 'sonner'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { requestEditorFileClose } from '../editor/editor-autosave'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { closeWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-close'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { withLocalSessionTabCloseOwner } from '@/runtime/local-session-tab-close-owner'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import { cancelStructuredAgentLaunch } from '@/lib/structured-agent-session-launch'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'

function reportStructuredSessionCloseError(error: unknown): void {
  toast.error(
    translate(
      'components.native-chat.structuredSessionCloseFailed',
      'Could not close this chat session'
    ),
    { description: error instanceof Error ? error.message : String(error) }
  )
}

export function createWorkspaceTabCloseCommands({
  worktreeId,
  groupTabs
}: {
  worktreeId: string
  groupTabs: Tab[]
}) {
  const { closeUnifiedTab, closeFile, setActiveWorktree } = useAppStore.getState()

  const closeEditorIfUnreferenced = (entityId: string, closingTabId: string) => {
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
        requestEditorFileClose(entityId)
        return false
      }
      closeFile(entityId)
    }
    return true
  }

  const leaveWorktreeIfEmpty = () => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    // Why: split-group closes bypass legacy Terminal.tsx; deselect the emptied worktree here or the window goes blank instead of landing.
    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }

  const closeItem = (
    itemId: string,
    opts?: { skipEmptyCheck?: boolean; skipRunningProcessConfirm?: boolean }
  ) => {
    const item = groupTabs.find((candidate) => candidate.id === itemId)
    if (!item) {
      return
    }
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
      useAppStore.getState(),
      worktreeId
    )
    if (item.contentType === 'agent-session') {
      // Cancel pending creation and retire the host session before removing its tab.
      cancelStructuredAgentLaunch(worktreeId, item.entityId)
      const target = getActiveRuntimeTarget({
        activeRuntimeEnvironmentId: runtimeEnvironmentId
      })
      void closeStructuredAgentSession(target, item.entityId)
        .then(() => {
          const closeHostTab = () =>
            callRuntimeRpc(target, 'session.tabs.close', {
              worktree: toRuntimeWorktreeSelector(worktreeId),
              tabId: `agent-session:${item.entityId}`,
              reason: 'user'
            })
          return target.kind === 'local'
            ? withLocalSessionTabCloseOwner(worktreeId, item.id, closeHostTab)
            : closeHostTab()
        })
        .then(() => {
          closeUnifiedTab(item.id)
          if (!opts?.skipEmptyCheck) {
            leaveWorktreeIfEmpty()
          }
        })
        .catch(reportStructuredSessionCloseError)
      return
    }
    if (item.contentType === 'terminal') {
      // Why: closeTerminalTab can defer behind a pin / running-process dialog, so the
      // empty check has to run on the actual close — never on cancel.
      closeTerminalTab(item.entityId, {
        ...(opts?.skipRunningProcessConfirm ? { skipRunningProcessConfirm: true } : {}),
        ...(!opts?.skipEmptyCheck ? { onClosed: leaveWorktreeIfEmpty } : {})
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
      const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
      if (!canCloseTab) {
        return
      }
      closeUnifiedTab(item.id)
    }
    if (!opts?.skipEmptyCheck) {
      leaveWorktreeIfEmpty()
    }
  }

  return { closeItem, leaveWorktreeIfEmpty }
}
