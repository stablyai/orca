// "Add to chat" from a file, preview or terminal: the selection goes to the chat last used in its workspace.
import type { Tab } from '../../../../shared/tab-types'
import { isStructuredTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AppState } from '@/store/types'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace-tab-palette-activation'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { formatNativeChatQuote } from './native-chat-quote-selection'

type WorkspaceChatState = Pick<AppState, 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'>

type WorkspaceChatTarget = { tab: Tab; scopeKey: string }

function chatDraftScopeKey(state: WorkspaceChatState, tab: Tab): string | null {
  if (isStructuredTab(tab)) {
    return structuredAgentSessionDraftScopeKey(tab.entityId)
  }
  if (tab.contentType !== 'terminal' || tab.viewMode !== 'chat') {
    return null
  }
  // The chat leaf, not the active one: a shell split beside the chat can hold focus.
  const leafId = state.terminalLayoutsByTabId[tab.entityId]?.chatLeafId
  return leafId && isTerminalLeafId(leafId) && !tab.entityId.includes(':')
    ? makePaneKey(tab.entityId, leafId)
    : null
}

export function findWorkspaceChatTarget(
  state: WorkspaceChatState,
  worktreeId: string
): WorkspaceChatTarget | null {
  let best: WorkspaceChatTarget | null = null
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    const scopeKey = chatDraftScopeKey(state, tab)
    if (scopeKey && (!best || (tab.lastFocusedAt ?? 0) > (best.tab.lastFocusedAt ?? 0))) {
      best = { tab, scopeKey }
    }
  }
  return best
}

/** Appends to the chat's draft, which holds it even while the chat is hidden, then shows that chat. */
export function addSelectionToWorkspaceChatOrExplain(worktreeId: string, reference: string): void {
  const state = useAppStore.getState()
  const target = findWorkspaceChatTarget(state, worktreeId)
  if (!target) {
    toast.error(
      translate(
        'components.native-chat.addSelectionNoChat',
        'Open a chat in this workspace, then add the selection again.'
      )
    )
    return
  }
  appendNativeChatDraftCache(target.scopeKey, formatNativeChatQuote(reference))
  const { tab } = target
  if (tab.contentType === 'agent-session') {
    activateStructuredAgentSessionTab({ worktreeId, tabId: tab.id })
    return
  }
  activateWorkspaceTabPaletteResult({
    worktreeId,
    groupId: tab.groupId,
    tabId: tab.id,
    entityId: tab.entityId,
    contentType: 'terminal',
    ...(tab.executionHostId ? { executionHostId: tab.executionHostId } : {})
  })
}
