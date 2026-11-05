// "Add to chat" from a file, preview or terminal: the selection goes to the chat the user picks.
import type { Tab } from '../../../../shared/tab-types'
import { isStructuredTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import type { AgentMessageTarget } from '@/lib/agent-message-target'
import type { NotesSendAgentTarget } from '@/lib/notes-send-agent-targets'
import { translate } from '@/i18n/i18n'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import { requestNativeChatComposerFocus } from './use-native-chat-composer-reveal-focus'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { appendQuoteToChatDraft } from './native-chat-selection-quote-draft'

type WorkspaceChatState = Pick<AppState, 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'>

/** `chatLeafId` is set for a chat over a terminal, whose split can hold shells beside the chat. */
type WorkspaceChatTarget = { tab: Tab; scopeKey: string; chatLeafId?: string }

/**
 * The composer an agent target can take a quote into: a Chat UI chat, or a terminal shown as chat
 * whose chat is that agent's pane. A plain terminal agent has no composer to hold unsent text.
 */
export function workspaceChatTargetFor(
  state: WorkspaceChatState,
  worktreeId: string,
  target: AgentMessageTarget
): WorkspaceChatTarget | null {
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  if (target.kind === 'structured-session') {
    const tab = tabs.find(
      (candidate) => isStructuredTab(candidate) && candidate.entityId === target.sessionId
    )
    return tab ? { tab, scopeKey: structuredAgentSessionDraftScopeKey(tab.entityId) } : null
  }
  const tab = tabs.find(
    (candidate) =>
      candidate.contentType === 'terminal' &&
      candidate.viewMode === 'chat' &&
      candidate.entityId === target.tabId
  )
  const chatLeafId = state.terminalLayoutsByTabId[target.tabId]?.chatLeafId
  return tab && chatLeafId === target.leafId && isTerminalLeafId(chatLeafId)
    ? { tab, scopeKey: makePaneKey(tab.entityId, chatLeafId), chatLeafId }
    : null
}

/** Unsent text needs a composer; a plain terminal agent only takes a send. */
export function withAddToChatEligibility(
  target: NotesSendAgentTarget,
  state: WorkspaceChatState,
  worktreeId: string
): NotesSendAgentTarget {
  return target.status !== 'eligible' ||
    workspaceChatTargetFor(state, worktreeId, target.messageTarget)
    ? target
    : { ...target, status: 'disabled', disabledReason: addToChatUnavailableLabel(target) }
}

export function addToChatUnavailableLabel(target: NotesSendAgentTarget): string {
  return target.messageTarget.kind === 'terminal'
    ? translate(
        'components.native-chat.addSelectionTerminalNotChat',
        'Switch this terminal to chat view to add text to it'
      )
    : translate('auto.components.editor.ReviewNotesSendMenu.chatGone', 'Chat is no longer open')
}

/** Appends the quote to the picked chat's draft, then shows that chat; nothing is sent. */
export function addQuoteToWorkspaceChat(
  worktreeId: string,
  target: AgentMessageTarget,
  quote: string
): boolean {
  const state = useAppStore.getState()
  const chat = workspaceChatTargetFor(state, worktreeId, target)
  if (!chat) {
    return false
  }
  appendQuoteToChatDraft(chat.scopeKey, quote)
  const { tab, chatLeafId } = chat
  if (!chatLeafId) {
    activateStructuredAgentSessionTab({ worktreeId, tabId: tab.id })
    return true
  }
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId })
  // Activating the chat leaf, not the tab, is what hands focus to the chat's composer; an
  // expanded shell beside it would hide it, so that collapses as moving to another pane does.
  activateTabAndFocusPane(tab.entityId, chatLeafId, { collapseExpandedPane: true })
  activateTerminalTabOnOwner(worktreeId, tab.entityId, chatLeafId)
  requestNativeChatComposerFocus(tab.entityId)
  return true
}
