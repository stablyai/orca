import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isWslHookRelayConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import type { AppState } from '../types'
import { patchTab } from './tab-group-state'
import { patchTerminalTabRow } from './tabs/tabs-host-mirroring'

/** Apply the launch preference when the execution host first supplies the CLI identity. */
export function antigravityInitialChatViewPatch(
  state: AppState,
  entry: AgentStatusEntry
): Partial<AppState> {
  const pane = parsePaneKey(entry.paneKey)
  const worktreeId = entry.worktreeId
  if (
    !pane ||
    !worktreeId ||
    entry.agentType !== 'antigravity' ||
    entry.restoredUnconfirmed === true ||
    entry.providerSession?.key !== 'conversation_id'
  ) {
    return {}
  }
  const terminal = state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === pane.tabId)
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.contentType === 'terminal' && candidate.entityId === pane.tabId
  )
  if (
    !terminal ||
    !tab ||
    terminal.launchAgent !== 'antigravity' ||
    terminal.viewMode !== undefined ||
    tab.viewMode !== undefined
  ) {
    return {}
  }
  const layout = state.terminalLayoutsByTabId[pane.tabId]
  const leaves = layout ? collectLeafIdsInOrder(layout.root) : []
  if (leaves.length > 0 && (leaves.length !== 1 || leaves[0] !== pane.leafId)) {
    return {}
  }
  const draft = state.nativeChatLaunchDraftByTabId[pane.tabId]
  const { viewMode } = initialAgentTabViewModeProps(state.settings, {
    agent: 'antigravity',
    providerSessionId: entry.providerSession.id,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      isWslHookRelayConnectionId(entry.connectionId) ? null : entry.connectionId
    ),
    ...(draft ? { promptDelivery: 'draft', launchDraftText: draft.text } : {})
  })
  if (viewMode !== 'chat') {
    return {}
  }
  return {
    ...patchTab(state.unifiedTabsByWorktree, tab.id, { viewMode }),
    ...patchTerminalTabRow(state.tabsByWorktree, terminal.id, { viewMode }),
    ...(layout
      ? {
          terminalLayoutsByTabId: {
            ...state.terminalLayoutsByTabId,
            [pane.tabId]: { ...layout, chatLeafId: pane.leafId }
          }
        }
      : {})
  }
}
