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
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { requestNativeChatComposerFocus } from './use-native-chat-composer-reveal-focus'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { appendQuoteToChatDraft } from './native-chat-selection-quote-draft'
import { formatNativeChatQuote } from './native-chat-quote-selection'
import { readPaneUse } from './chat-pane-use'

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

/** The chat used last: the later of its last activation and a click or keystroke in it this session. */
export function findWorkspaceChatTarget(
  state: WorkspaceChatState,
  worktreeId: string,
  usedAt: (worktreeId: string, entityId: string) => number | undefined = readPaneUse
): WorkspaceChatTarget | null {
  let best: WorkspaceChatTarget | null = null
  let bestAt = -1
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    const candidate = chatTarget(state, tab)
    const at = Math.max(tab.lastFocusedAt ?? 0, usedAt(worktreeId, tab.entityId) ?? 0)
    if (candidate && at > bestAt) {
      best = candidate
      bestAt = at
    }
  }
  return best
}

/** Appends to the chat's draft, then shows that chat. */
export function addSelectionToWorkspaceChatOrExplain(sourceId: string, reference: string): void {
  const state = useAppStore.getState()
  // The floating terminal belongs to no workspace; it floats over the one on screen.
  const worktreeId =
    sourceId === FLOATING_TERMINAL_WORKTREE_ID ? (state.activeWorktreeId ?? sourceId) : sourceId
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
  appendQuoteToChatDraft(target.scopeKey, formatNativeChatQuote(reference))
  const { tab, chatLeafId } = target
  if (!chatLeafId) {
    activateStructuredAgentSessionTab({ worktreeId, tabId: tab.id })
    return
  }
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId })
  // Activating the chat leaf, not the tab, is what hands focus to the chat's composer; an
  // expanded shell beside it would hide it, so that collapses as moving to another pane does.
  activateTabAndFocusPane(tab.entityId, chatLeafId, { collapseExpandedPane: true })
  activateTerminalTabOnOwner(worktreeId, tab.entityId, chatLeafId)
  requestNativeChatComposerFocus(tab.entityId)
}
