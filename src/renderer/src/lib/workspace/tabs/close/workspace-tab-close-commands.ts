import { editorContentIsReferenced } from '@/store/slices/editor/tabs/workspace-editor-files'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { useAppStore } from '../../../../store/index'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import { requestEditorFileClose } from '../../../../components/editor/autosave/editor-autosave'
import { runAfterEditorFramesFlush } from '../../../../components/editor/save/flush/editor-pending-flush'
import { closeTerminalTab } from '../../../../components/terminal/tab-lifecycle/terminal-tab-actions'
import { closeWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-close'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { admitStructuredAgentSession } from '@/lib/agent-session/structured-agent-session-busy'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  pushClosedChatTabSnapshot,
  pushRecentlyClosedTabKind
} from '@/store/slices/tabs/recently-closed-tabs'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'

export function createWorkspaceTabCloseCommands({
  worktreeId,
  groupTabs
}: {
  worktreeId: string
  groupTabs: Tab[]
}) {
  const { closeUnifiedTab } = useAppStore.getState()

  const closeEditorIfUnreferenced = (
    entityId: string,
    closingTabId: string,
    whenEmptied: (() => void) | null
  ) => {
    const otherReference = editorContentIsReferenced(useAppStore.getState(), entityId, closingTabId)
    if (!otherReference) {
      if (needsSavePromptOnClose(useAppStore.getState(), entityId)) {
        // Why: route through Terminal.tsx so the unsaved-confirmation save/discard queue stays centralized across all close paths.
        requestEditorFileClose(entityId, {
          tabId: closingTabId,
          ...(whenEmptied ? { onClosed: whenEmptied } : {})
        })
        return false
      }
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
      const agent = item.agentSessionAgent
      const executionHostId = item.executionHostId
      const close = () => {
        const state = useAppStore.getState()
        const target = structuredAgentSessionTargetForTab(state, item)
        const providerSessionId = target
          ? findStructuredAgentSessionReadOwner(
              item.entityId,
              target,
              item.executionHostId ?? ''
            )?.getSnapshot().providerSession?.id
          : undefined
        if (!state.closeUnifiedTab(item.id)) {
          return
        }
        if (agent && isTuiAgent(agent) && executionHostId && providerSessionId) {
          useAppStore.setState((s) => ({
            recentlyClosedChatTabsByWorktree: pushClosedChatTabSnapshot(
              s.recentlyClosedChatTabsByWorktree,
              worktreeId,
              {
                providerSessionId,
                agent,
                executionHostId,
                ...(item.customLabel ? { customTitle: item.customLabel } : {})
              }
            ),
            recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
              s.recentlyClosedTabKindsByWorktree,
              worktreeId,
              'chat'
            )
          }))
        }
        whenEmptied?.()
      }
      if (
        !opts?.skipRunningProcessConfirm &&
        useAppStore.getState().settings?.skipCloseTerminalWithRunningProcessConfirm !== true
      ) {
        void admitStructuredAgentSession(
          worktreeId,
          item,
          'close',
          (busy, attempt) =>
            new Promise<void>((resolve) => {
              const confirmed = () => {
                try {
                  if (attempt.current()) {
                    close()
                  }
                } finally {
                  resolve()
                }
              }
              if (!busy) {
                return confirmed()
              }
              useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
                // Consent belongs to this attempt; a reused tab ID must not inherit its dialog.
                terminalTabId: createBrowserUuid(),
                copyKind: 'chat-agent',
                onConfirm: confirmed,
                onCancel: resolve
              })
            })
        )
      } else {
        close()
      }
      return
    }
    if (item.contentType === 'terminal') {
      // Run the empty check only after deferred pin/process confirmations actually close the tab.
      closeTerminalTab(item.entityId, {
        reason: 'user',
        ...(opts?.skipRunningProcessConfirm ? { skipRunningProcessConfirm: true } : {}),
        ...(whenEmptied ? { onClosed: whenEmptied } : {})
      })
      return
    }
    if (item.contentType === 'browser') {
      const plan = closeWorkspaceBrowserTab(worktreeId, item.entityId, item.id)
      // Unwinding an unfinished create must preserve selection rather than count as emptying the workspace.
      if (!plan.closesLocally || plan.localCloseReason === 'cleanup') {
        return
      }
    } else if (item.contentType === 'simulator' || item.contentType === 'room') {
      closeUnifiedTab(item.id)
    } else {
      // Why: a custom editor frame may still hold edits the dirty check must see.
      runAfterEditorFramesFlush(useAppStore.getState(), [item.entityId], (deferred) => {
        // A rename during the flush keeps the tab id but moves its entity; act on the live one.
        const live = deferred
          ? (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
              (tab) => tab.id === item.id
            )
          : item
        if (!live || !isEditorTabContentType(live.contentType)) {
          return
        }
        if (closeEditorIfUnreferenced(live.entityId, item.id, whenEmptied)) {
          closeUnifiedTab(item.id)
          whenEmptied?.()
        }
      })
      return
    }
    whenEmptied?.()
  }

  return { closeItem }
}
