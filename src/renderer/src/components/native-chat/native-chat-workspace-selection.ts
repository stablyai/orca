// "Add to chat" from a file, preview or terminal: the selection goes to the chat last used in its workspace.
import type { Tab } from '../../../../shared/tab-types'
import { isStructuredTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AppState } from '@/store/types'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import {
  appendToNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { formatNativeChatQuote } from './native-chat-quote-selection'

type WorkspaceChatState = Pick<AppState, 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'>

/** `chatLeafId` is set for a chat over a terminal, whose split can hold shells beside the chat. */
type WorkspaceChatTarget = { tab: Tab; scopeKey: string; chatLeafId?: string }

function chatTarget(state: WorkspaceChatState, tab: Tab): WorkspaceChatTarget | null {
  if (isStructuredTab(tab)) {
    return { tab, scopeKey: structuredAgentSessionDraftScopeKey(tab.entityId) }
  }
  if (tab.contentType !== 'terminal' || tab.viewMode !== 'chat') {
    return null
  }
  const chatLeafId = state.terminalLayoutsByTabId[tab.entityId]?.chatLeafId
  return chatLeafId && isTerminalLeafId(chatLeafId) && !tab.entityId.includes(':')
    ? { tab, scopeKey: makePaneKey(tab.entityId, chatLeafId), chatLeafId }
    : null
}

export function findWorkspaceChatTarget(
  state: WorkspaceChatState,
  worktreeId: string
): WorkspaceChatTarget | null {
  let best: WorkspaceChatTarget | null = null
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    const candidate = chatTarget(state, tab)
    if (candidate && (!best || (tab.lastFocusedAt ?? 0) > (best.tab.lastFocusedAt ?? 0))) {
      best = candidate
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
  // Independent like a typed addition: adding the same lines twice adds them twice.
  appendToNativeChatComposerDraft(
    target.scopeKey,
    { text: formatNativeChatQuote(reference) },
    undefined,
    undefined,
    true
  )
  const { tab, chatLeafId } = target
  if (!chatLeafId) {
    activateStructuredAgentSessionTab({ worktreeId, tabId: tab.id })
    return
  }
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId })
  // Activating the chat leaf, not the tab, is what hands focus to the chat's composer.
  activateTabAndFocusPane(tab.entityId, chatLeafId)
  activateTerminalTabOnOwner(worktreeId, tab.entityId, chatLeafId)
}
