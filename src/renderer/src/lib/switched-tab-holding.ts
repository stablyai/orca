import type { Tab } from '../../../shared/tab-types'
import type { WindowTabContent } from '../../../shared/window-tab-content'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'

/** The tab, now holding `content`. Kept: id, group, place, pin, color. Reset: what described
 *  the old content. */
export function tabHolding(tab: Tab, content: WindowTabContent): Tab {
  return {
    id: tab.id,
    entityId: content.kind === 'terminal' ? content.terminalId : content.sessionId,
    groupId: tab.groupId,
    worktreeId: tab.worktreeId,
    ...(tab.executionHostId ? { executionHostId: tab.executionHostId } : {}),
    contentType: content.kind,
    label: content.kind === 'terminal' ? tab.label : defaultAgentChatLabel(content.agent),
    customLabel: null,
    color: tab.color,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt,
    ...(tab.isPinned ? { isPinned: true } : {}),
    ...(tab.lastFocusedAt !== undefined ? { lastFocusedAt: tab.lastFocusedAt } : {}),
    ...(content.kind === 'agent-session' ? { agentSessionAgent: content.agent } : {})
  }
}
